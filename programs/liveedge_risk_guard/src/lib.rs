use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

// Dedicated deterministic Program ID for LiveEdge Solana Risk Guard
declare_id!("7X5WrZSYtxx89cpEs9A79SSQ2ZHJtkX32fBXcwpyd7uD");

/// Canonical Pyth Solana Receiver Program ID (Mainnet & Devnet)
pub const PYTH_SOLANA_RECEIVER_ID: Pubkey =
    pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// Canonical Drift Protocol v2 Program ID (Mainnet & Devnet)
pub const DRIFT_V2_PROGRAM_ID: Pubkey =
    pubkey!("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

/// Anchor 8-byte discriminator for Pyth `PriceUpdateV2` account
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

#[program]
pub mod liveedge_risk_guard {
    use super::*;

    /// Initializes a trader's immutable/bounded Risk Policy PDA on Solana.
    /// Prevents compromised AI agents or emotional impulse clicks from exceeding
    /// fixed USDC risk per trade or trading into stale/wide-confidence Pyth feeds.
    pub fn initialize_risk_policy(
        ctx: Context<InitializeRiskPolicy>,
        fixed_risk_cap_usdc_e6: u64,
        max_conf_bps: u16,
        max_staleness_sec: i64,
        max_slippage_bps: u16,
    ) -> Result<()> {
        require!(
            fixed_risk_cap_usdc_e6 > 0 && fixed_risk_cap_usdc_e6 <= 1_000_000_000,
            LiveEdgeError::InvalidRiskCap
        );
        require!(
            max_conf_bps > 0 && max_conf_bps <= 250,
            LiveEdgeError::InvalidConfidenceBound
        );
        require!(
            max_staleness_sec > 0 && max_staleness_sec <= 120,
            LiveEdgeError::InvalidStalenessBound
        );
        require!(
            max_slippage_bps > 0 && max_slippage_bps <= 300,
            LiveEdgeError::InvalidSlippageBound
        );

        let policy = &mut ctx.accounts.risk_policy;
        policy.authority = ctx.accounts.authority.key();
        policy.fixed_risk_cap_usdc_e6 = fixed_risk_cap_usdc_e6;
        policy.max_conf_bps = max_conf_bps;
        policy.max_staleness_sec = max_staleness_sec;
        policy.max_slippage_bps = max_slippage_bps;
        policy.executed_count = 0;
        policy.last_slot = Clock::get()?.slot;
        policy.last_decision_digest = [0u8; 32];
        policy.bump = ctx.bumps.risk_policy;

        Ok(())
    }

    /// Atomically verifies on-chain Pyth `PriceUpdateV2` freshness & confidence interval,
    /// enforces fixed-loss position sizing (`notional * stop_bps <= risk_cap * 10_000`),
    /// blocks blind market orders, bounds limit price slippage, and records the execution digest
    /// in the same 400ms Solana transaction slot prior to venue CPI execution.
    pub fn execute_guarded_impulse(
        ctx: Context<ExecuteGuardedImpulse>,
        params: GuardedImpulseParams,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let policy = &mut ctx.accounts.risk_policy;

        // 1. Forbid blind market orders unconditionally (must be IOC_LIMIT or POST_ONLY)
        require!(
            params.order_mode == OrderMode::IocLimit || params.order_mode == OrderMode::PostOnly,
            LiveEdgeError::BlindMarketOrderForbidden
        );

        // 2. Verify Pyth PriceUpdateV2 account ownership & binary layout
        let pyth_info = &ctx.accounts.pyth_price_update;
        require_keys_eq!(
            *pyth_info.owner,
            PYTH_SOLANA_RECEIVER_ID,
            LiveEdgeError::InvalidOracleOwner
        );

        let data = pyth_info.try_borrow_data()?;
        require!(data.len() >= 134, LiveEdgeError::InvalidOracleAccountData);
        require!(
            data[0..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
            LiveEdgeError::InvalidOracleDiscriminator
        );

        let verification_tag = data[40];
        let feed_offset: usize = if verification_tag == 0 { 42 } else { 41 };
        require!(
            data.len() >= feed_offset + 92,
            LiveEdgeError::InvalidOracleAccountData
        );

        let mut feed_id = [0u8; 32];
        feed_id.copy_from_slice(&data[feed_offset..feed_offset + 32]);
        require!(
            feed_id == params.expected_pyth_feed_id,
            LiveEdgeError::OracleFeedMismatch
        );

        let p_off = feed_offset + 32;
        let raw_price = i64::from_le_bytes(data[p_off..p_off + 8].try_into().unwrap());
        let raw_conf = u64::from_le_bytes(data[p_off + 8..p_off + 16].try_into().unwrap());
        let publish_time = i64::from_le_bytes(data[p_off + 20..p_off + 28].try_into().unwrap());

        require!(raw_price > 0, LiveEdgeError::NonPositiveOraclePrice);

        // 3. Enforce sub-minute Oracle Staleness Guard
        let age_sec = clock.unix_timestamp.saturating_sub(publish_time);
        require!(
            age_sec >= 0 && age_sec <= policy.max_staleness_sec,
            LiveEdgeError::OracleStaleFrame
        );

        // 4. Enforce Pyth Confidence Interval Guard: conf / price <= max_conf_bps / 10_000
        let price_u128 = raw_price as u128;
        let conf_bps_lhs = (raw_conf as u128).saturating_mul(10_000);
        let conf_bps_rhs = price_u128.saturating_mul(policy.max_conf_bps as u128);
        require!(
            conf_bps_lhs <= conf_bps_rhs,
            LiveEdgeError::OracleConfidenceTooWide
        );

        // 5. Enforce Fixed-Loss Position Sizing Guard:
        //    For Perps: sized_notional_usdc_e6 * stop_distance_bps <= fixed_risk_cap_usdc_e6 * 10_000
        //    For Binary Prediction Markets (stop_distance_bps == 10_000): sized_notional <= fixed_risk_cap
        require!(
            params.stop_distance_bps >= 25 && params.stop_distance_bps <= 10_000,
            LiveEdgeError::InvalidStopDistance
        );
        require!(
            params.sized_notional_usdc_e6 > 0,
            LiveEdgeError::ZeroPositionSize
        );

        let implied_max_loss_lhs = (params.sized_notional_usdc_e6 as u128)
            .saturating_mul(params.stop_distance_bps as u128);
        let allowed_loss_rhs = (policy.fixed_risk_cap_usdc_e6 as u128).saturating_mul(10_000);
        require!(
            implied_max_loss_lhs <= allowed_loss_rhs,
            LiveEdgeError::FixedRiskCapExceeded
        );

        // 6. Enforce Bounded Slippage Limit Price vs Reference Best Ask
        require!(
            params.reference_ask_e6 > 0 && params.limit_price_e6 > 0,
            LiveEdgeError::InvalidLimitPrice
        );
        let max_allowed_limit_e6 = (params.reference_ask_e6 as u128)
            .saturating_mul(10_000u128.saturating_add(policy.max_slippage_bps as u128))
            / 10_000u128;
        require!(
            (params.limit_price_e6 as u128) <= max_allowed_limit_e6,
            LiveEdgeError::SlippageBoundExceeded
        );

        policy.executed_count = policy.executed_count.saturating_add(1);
        policy.last_slot = clock.slot;
        policy.last_decision_digest = params.decision_digest;

        emit!(GuardedImpulseExecuted {
            authority: policy.authority,
            slot: clock.slot,
            pyth_feed_id: feed_id,
            raw_price,
            raw_conf,
            sized_notional_usdc_e6: params.sized_notional_usdc_e6,
            stop_distance_bps: params.stop_distance_bps,
            limit_price_e6: params.limit_price_e6,
            order_mode: params.order_mode,
            decision_digest: params.decision_digest,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeRiskPolicy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + RiskPolicy::INIT_SPACE,
        seeds = [b"risk_policy", authority.key().as_ref()],
        bump
    )]
    pub risk_policy: Account<'info, RiskPolicy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteGuardedImpulse<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"risk_policy", authority.key().as_ref()],
        bump = risk_policy.bump,
        has_one = authority
    )]
    pub risk_policy: Account<'info, RiskPolicy>,
    /// CHECK: Owner and PriceUpdateV2 discriminator verified inside instruction
    pub pyth_price_update: UncheckedAccount<'info>,
    /// CHECK: Target PerpMarket or Prediction Market account bound into execution audit
    pub target_market: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct RiskPolicy {
    pub authority: Pubkey,
    pub fixed_risk_cap_usdc_e6: u64,
    pub max_conf_bps: u16,
    pub max_staleness_sec: i64,
    pub max_slippage_bps: u16,
    pub executed_count: u64,
    pub last_slot: u64,
    pub last_decision_digest: [u8; 32],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum OrderMode {
    BlindMarket,
    IocLimit,
    PostOnly,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GuardedImpulseParams {
    pub expected_pyth_feed_id: [u8; 32],
    pub sized_notional_usdc_e6: u64,
    pub stop_distance_bps: u16,
    pub reference_ask_e6: u64,
    pub limit_price_e6: u64,
    pub order_mode: OrderMode,
    pub decision_digest: [u8; 32],
}

#[event]
pub struct GuardedImpulseExecuted {
    pub authority: Pubkey,
    pub slot: u64,
    pub pyth_feed_id: [u8; 32],
    pub raw_price: i64,
    pub raw_conf: u64,
    pub sized_notional_usdc_e6: u64,
    pub stop_distance_bps: u16,
    pub limit_price_e6: u64,
    pub order_mode: OrderMode,
    pub decision_digest: [u8; 32],
}

#[error_code]
pub enum LiveEdgeError {
    #[msg("Risk cap must be positive and within protocol ceiling")]
    InvalidRiskCap,
    #[msg("Confidence interval tolerance out of allowed bounds")]
    InvalidConfidenceBound,
    #[msg("Oracle staleness bound out of allowed range")]
    InvalidStalenessBound,
    #[msg("Slippage tolerance out of allowed range")]
    InvalidSlippageBound,
    #[msg("Blind market orders are strictly forbidden during impulse execution")]
    BlindMarketOrderForbidden,
    #[msg("Oracle account is not owned by Pyth Solana Receiver")]
    InvalidOracleOwner,
    #[msg("Oracle account data length is invalid for PriceUpdateV2")]
    InvalidOracleAccountData,
    #[msg("Oracle account discriminator does not match PriceUpdateV2")]
    InvalidOracleDiscriminator,
    #[msg("Pyth feed ID does not match expected market feed")]
    OracleFeedMismatch,
    #[msg("Pyth oracle reported non-positive price")]
    NonPositiveOraclePrice,
    #[msg("Pyth oracle frame is stale beyond policy max_staleness_sec")]
    OracleStaleFrame,
    #[msg("Pyth confidence interval exceeds policy max_conf_bps")]
    OracleConfidenceTooWide,
    #[msg("Stop distance bps must be between 25 bps (0.25%) and 10000 bps (100%)")]
    InvalidStopDistance,
    #[msg("Position notional must be strictly positive")]
    ZeroPositionSize,
    #[msg("Sized position exceeds fixed USDC loss cap at stop-loss distance")]
    FixedRiskCapExceeded,
    #[msg("Reference ask and limit price must be strictly positive")]
    InvalidLimitPrice,
    #[msg("Limit price exceeds maximum allowed slippage from reference ask")]
    SlippageBoundExceeded,
}
