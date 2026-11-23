#![allow(unexpected_cfgs)]

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

/// Scales Pyth `(raw_price, exponent)` to USD `1e6` (`PRICE_PRECISION`) without floating point.
pub fn scale_pyth_price_to_e6(raw_price: i64, exponent: i32) -> Result<u128> {
    require!(raw_price > 0, LiveEdgeError::NonPositiveOraclePrice);
    require!(
        (-18..=6).contains(&exponent),
        LiveEdgeError::InvalidOracleExponent
    );

    let price_u128 = raw_price as u128;
    let shift = 6i32 + exponent;
    let scaled = if shift >= 0 {
        let factor = 10u128
            .checked_pow(shift as u32)
            .ok_or(error!(LiveEdgeError::InvalidOracleExponent))?;
        price_u128
            .checked_mul(factor)
            .ok_or(error!(LiveEdgeError::InvalidOracleExponent))?
    } else {
        let divisor = 10u128
            .checked_pow((-shift) as u32)
            .ok_or(error!(LiveEdgeError::InvalidOracleExponent))?;
        price_u128 / divisor
    };

    require!(scaled > 0, LiveEdgeError::NonPositiveOraclePrice);
    Ok(scaled)
}

/// Core pure verifier enforcing all on-chain Pyth, Drift Market, Fixed-Loss, and Slippage invariants.
pub fn verify_and_apply_guarded_impulse(
    policy: &mut RiskPolicy,
    pyth_owner: &Pubkey,
    pyth_data: &[u8],
    target_market_key: &Pubkey,
    target_market_owner: &Pubkey,
    target_market_data: &[u8],
    clock_slot: u64,
    clock_unix_timestamp: i64,
    params: &GuardedImpulseParams,
) -> Result<( [u8; 32], i64, u64, u64 )> {
    // 1. Unconditionally forbid blind market orders (must be IOC_LIMIT or POST_ONLY)
    require!(
        params.order_mode == OrderMode::IocLimit || params.order_mode == OrderMode::PostOnly,
        LiveEdgeError::BlindMarketOrderForbidden
    );

    // 2. Verify target Drift Perp/Prediction Market account ownership & self-pubkey layout
    require_keys_eq!(
        *target_market_owner,
        DRIFT_V2_PROGRAM_ID,
        LiveEdgeError::InvalidTargetMarketOwner
    );
    require!(
        target_market_data.len() >= 300,
        LiveEdgeError::InvalidTargetMarketData
    );
    require!(
        target_market_data[8..40] == target_market_key.to_bytes(),
        LiveEdgeError::InvalidTargetMarketData
    );

    // 3. Verify Pyth PriceUpdateV2 account ownership, discriminator & VerificationLevel::Full
    require_keys_eq!(
        *pyth_owner,
        PYTH_SOLANA_RECEIVER_ID,
        LiveEdgeError::InvalidOracleOwner
    );
    require!(
        pyth_data.len() >= 133,
        LiveEdgeError::InvalidOracleAccountData
    );
    require!(
        pyth_data[0..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        LiveEdgeError::InvalidOracleDiscriminator
    );

    // Pyth VerificationLevel Borsh enum: 0 => Partial { num_signatures: u8 }, 1 => Full
    let verification_tag = pyth_data[40];
    require!(
        verification_tag <= 1,
        LiveEdgeError::InvalidOracleAccountData
    );
    require!(
        verification_tag == 1,
        LiveEdgeError::InsufficientOracleVerification
    );

    let feed_offset: usize = 41;
    require!(
        pyth_data.len() >= feed_offset + 92,
        LiveEdgeError::InvalidOracleAccountData
    );

    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&pyth_data[feed_offset..feed_offset + 32]);
    require!(
        feed_id == params.expected_pyth_feed_id,
        LiveEdgeError::OracleFeedMismatch
    );

    let p_off = feed_offset + 32;
    let raw_price = i64::from_le_bytes(pyth_data[p_off..p_off + 8].try_into().unwrap());
    let raw_conf = u64::from_le_bytes(pyth_data[p_off + 8..p_off + 16].try_into().unwrap());
    let exponent = i32::from_le_bytes(pyth_data[p_off + 16..p_off + 20].try_into().unwrap());
    let publish_time = i64::from_le_bytes(pyth_data[p_off + 20..p_off + 28].try_into().unwrap());

    let oracle_price_e6 = scale_pyth_price_to_e6(raw_price, exponent)?;

    // 4. Enforce sub-minute Oracle Staleness Guard (reject stale or future-skewed >5s frames)
    let age_sec = clock_unix_timestamp
        .checked_sub(publish_time)
        .ok_or(error!(LiveEdgeError::OracleStaleFrame))?;
    require!(
        age_sec >= -5 && age_sec <= policy.max_staleness_sec,
        LiveEdgeError::OracleStaleFrame
    );

    // 5. Enforce Pyth Confidence Interval Guard: conf / price <= max_conf_bps / 10_000
    let price_u128 = raw_price as u128;
    let conf_bps_lhs = (raw_conf as u128).saturating_mul(10_000);
    let conf_bps_rhs = price_u128.saturating_mul(policy.max_conf_bps as u128);
    require!(
        conf_bps_lhs <= conf_bps_rhs,
        LiveEdgeError::OracleConfidenceTooWide
    );

    // 6. Enforce Fixed-Loss Position Sizing Guard:
    //    sized_notional_usdc_e6 * stop_distance_bps <= fixed_risk_cap_usdc_e6 * 10_000
    require!(
        params.stop_distance_bps >= 25 && params.stop_distance_bps <= 10_000,
        LiveEdgeError::InvalidStopDistance
    );
    if params.market_kind == MarketKind::BinaryPrediction {
        require!(
            params.stop_distance_bps == 10_000,
            LiveEdgeError::InvalidStopDistance
        );
    }
    require!(
        params.sized_notional_usdc_e6 > 0,
        LiveEdgeError::ZeroPositionSize
    );

    let implied_max_loss_lhs =
        (params.sized_notional_usdc_e6 as u128).saturating_mul(params.stop_distance_bps as u128);
    let allowed_loss_rhs = (policy.fixed_risk_cap_usdc_e6 as u128).saturating_mul(10_000);
    require!(
        implied_max_loss_lhs <= allowed_loss_rhs,
        LiveEdgeError::FixedRiskCapExceeded
    );

    // 7. Enforce Pyth-Anchored Slippage & Directional Limit Bounds
    require!(
        params.reference_price_e6 > 0 && params.limit_price_e6 > 0,
        LiveEdgeError::InvalidLimitPrice
    );
    let ref_e6 = params.reference_price_e6 as u128;
    let lim_e6 = params.limit_price_e6 as u128;

    match params.market_kind {
        MarketKind::Perp => {
            // Anchor caller's reference_price_e6 directly to on-chain Pyth `oracle_price_e6`
            let abs_dev = ref_e6.abs_diff(oracle_price_e6);
            require!(
                abs_dev.saturating_mul(10_000)
                    <= oracle_price_e6.saturating_mul(policy.max_oracle_deviation_bps as u128),
                LiveEdgeError::OraclePriceDeviationExceeded
            );

            let slip_bps = policy.max_slippage_bps as u128;
            let total_oracle_bps =
                (policy.max_oracle_deviation_bps as u128).saturating_add(slip_bps);

            match params.trade_side {
                TradeSide::Long => {
                    let max_from_ref = ref_e6.saturating_mul(10_000u128 + slip_bps) / 10_000u128;
                    let max_from_pyth =
                        oracle_price_e6.saturating_mul(10_000u128 + total_oracle_bps) / 10_000u128;
                    require!(
                        lim_e6 <= max_from_ref && lim_e6 <= max_from_pyth,
                        LiveEdgeError::SlippageBoundExceeded
                    );
                }
                TradeSide::Short => {
                    let min_from_ref =
                        ref_e6.saturating_mul(10_000u128.saturating_sub(slip_bps)) / 10_000u128;
                    let min_from_pyth = oracle_price_e6
                        .saturating_mul(10_000u128.saturating_sub(total_oracle_bps))
                        / 10_000u128;
                    require!(
                        lim_e6 >= min_from_ref && lim_e6 >= min_from_pyth,
                        LiveEdgeError::SlippageBoundExceeded
                    );
                }
            }
        }
        MarketKind::BinaryPrediction => {
            // Binary prediction contracts trade in [0.01, 0.99] ($1e4 .. $99e4 in e6 precision)
            require!(
                (10_000..=990_000).contains(&ref_e6) && (10_000..=990_000).contains(&lim_e6),
                LiveEdgeError::InvalidLimitPrice
            );
            // 1 probability bps = $0.0001 = 100 in e6 units (e.g. 150 bps = 1.5 cents = 15_000 e6)
            let allowed_prob_bps = (policy.max_slippage_bps.max(150)) as u128;
            let max_prob_delta_e6 = allowed_prob_bps.saturating_mul(100);

            match params.trade_side {
                TradeSide::Long => {
                    require!(
                        lim_e6 <= ref_e6.saturating_add(max_prob_delta_e6),
                        LiveEdgeError::SlippageBoundExceeded
                    );
                }
                TradeSide::Short => {
                    require!(
                        lim_e6.saturating_add(max_prob_delta_e6) >= ref_e6,
                        LiveEdgeError::SlippageBoundExceeded
                    );
                }
            }
        }
    }

    policy.executed_count = policy.executed_count.saturating_add(1);
    policy.last_slot = clock_slot;
    policy.last_decision_digest = params.decision_digest;

    Ok((feed_id, raw_price, raw_conf, oracle_price_e6 as u64))
}

#[program]
pub mod liveedge_risk_guard {
    use super::*;

    /// Initializes a trader's bounded Risk Policy PDA on Solana.
    pub fn initialize_risk_policy(
        ctx: Context<InitializeRiskPolicy>,
        fixed_risk_cap_usdc_e6: u64,
        max_conf_bps: u16,
        max_staleness_sec: i64,
        max_slippage_bps: u16,
        max_oracle_deviation_bps: u16,
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
        require!(
            max_oracle_deviation_bps > 0 && max_oracle_deviation_bps <= 500,
            LiveEdgeError::InvalidOracleDeviationBound
        );

        let policy = &mut ctx.accounts.risk_policy;
        policy.authority = ctx.accounts.authority.key();
        policy.fixed_risk_cap_usdc_e6 = fixed_risk_cap_usdc_e6;
        policy.max_conf_bps = max_conf_bps;
        policy.max_staleness_sec = max_staleness_sec;
        policy.max_slippage_bps = max_slippage_bps;
        policy.max_oracle_deviation_bps = max_oracle_deviation_bps;
        policy.executed_count = 0;
        policy.last_slot = Clock::get()?.slot;
        policy.last_decision_digest = [0u8; 32];
        policy.bump = ctx.bumps.risk_policy;

        Ok(())
    }

    /// Atomically verifies Pyth `PriceUpdateV2` (`VerificationLevel::Full`, freshness, `±conf`),
    /// verifies Drift v2 `PerpMarket` account ownership, enforces fixed-loss position sizing,
    /// anchors limit price slippage against Pyth `raw_price`, and records the execution digest.
    pub fn execute_guarded_impulse(
        ctx: Context<ExecuteGuardedImpulse>,
        params: GuardedImpulseParams,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let policy = &mut ctx.accounts.risk_policy;

        let pyth_info = &ctx.accounts.pyth_price_update;
        let pyth_data = pyth_info.try_borrow_data()?;

        let market_info = &ctx.accounts.target_market;
        let market_data = market_info.try_borrow_data()?;

        let (feed_id, raw_price, raw_conf, oracle_price_e6) = verify_and_apply_guarded_impulse(
            policy,
            pyth_info.owner,
            &pyth_data,
            &market_info.key(),
            market_info.owner,
            &market_data,
            clock.slot,
            clock.unix_timestamp,
            &params,
        )?;

        emit!(GuardedImpulseExecuted {
            authority: policy.authority,
            slot: clock.slot,
            pyth_feed_id: feed_id,
            raw_price,
            raw_conf,
            oracle_price_e6,
            sized_notional_usdc_e6: params.sized_notional_usdc_e6,
            stop_distance_bps: params.stop_distance_bps,
            limit_price_e6: params.limit_price_e6,
            order_mode: params.order_mode,
            trade_side: params.trade_side,
            market_kind: params.market_kind,
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
    /// CHECK: Verified against PYTH_SOLANA_RECEIVER_ID, discriminator, and VerificationLevel::Full
    pub pyth_price_update: UncheckedAccount<'info>,
    /// CHECK: Verified against DRIFT_V2_PROGRAM_ID owner and PerpMarket self-pubkey header
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
    pub max_oracle_deviation_bps: u16,
    pub executed_count: u64,
    pub last_slot: u64,
    pub last_decision_digest: [u8; 32],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum OrderMode {
    BlindMarket,
    IocLimit,
    PostOnly,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum TradeSide {
    Long,
    Short,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketKind {
    Perp,
    BinaryPrediction,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GuardedImpulseParams {
    pub expected_pyth_feed_id: [u8; 32],
    pub sized_notional_usdc_e6: u64,
    pub stop_distance_bps: u16,
    pub reference_price_e6: u64,
    pub limit_price_e6: u64,
    pub order_mode: OrderMode,
    pub trade_side: TradeSide,
    pub market_kind: MarketKind,
    pub decision_digest: [u8; 32],
}

#[event]
pub struct GuardedImpulseExecuted {
    pub authority: Pubkey,
    pub slot: u64,
    pub pyth_feed_id: [u8; 32],
    pub raw_price: i64,
    pub raw_conf: u64,
    pub oracle_price_e6: u64,
    pub sized_notional_usdc_e6: u64,
    pub stop_distance_bps: u16,
    pub limit_price_e6: u64,
    pub order_mode: OrderMode,
    pub trade_side: TradeSide,
    pub market_kind: MarketKind,
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
    #[msg("Oracle deviation tolerance out of allowed range")]
    InvalidOracleDeviationBound,
    #[msg("Blind market orders are strictly forbidden during impulse execution")]
    BlindMarketOrderForbidden,
    #[msg("Target market account is not owned by Drift Protocol v2")]
    InvalidTargetMarketOwner,
    #[msg("Target market account data does not match Drift PerpMarket header")]
    InvalidTargetMarketData,
    #[msg("Oracle account is not owned by Pyth Solana Receiver")]
    InvalidOracleOwner,
    #[msg("Oracle account data length or enum tag is invalid for PriceUpdateV2")]
    InvalidOracleAccountData,
    #[msg("Oracle account discriminator does not match PriceUpdateV2")]
    InvalidOracleDiscriminator,
    #[msg("Pyth PriceUpdateV2 must have VerificationLevel::Full guardian quorum")]
    InsufficientOracleVerification,
    #[msg("Pyth feed ID does not match expected market feed")]
    OracleFeedMismatch,
    #[msg("Pyth oracle reported non-positive price")]
    NonPositiveOraclePrice,
    #[msg("Pyth oracle exponent is outside supported range")]
    InvalidOracleExponent,
    #[msg("Pyth oracle frame is stale beyond policy max_staleness_sec")]
    OracleStaleFrame,
    #[msg("Pyth confidence interval exceeds policy max_conf_bps")]
    OracleConfidenceTooWide,
    #[msg("Stop distance bps must be valid (and 10000 bps for binary prediction markets)")]
    InvalidStopDistance,
    #[msg("Position notional must be strictly positive")]
    ZeroPositionSize,
    #[msg("Sized position exceeds fixed USDC loss cap at stop-loss distance")]
    FixedRiskCapExceeded,
    #[msg("Reference price and limit price must be strictly positive and within bounds")]
    InvalidLimitPrice,
    #[msg("Caller reference price deviates from on-chain Pyth price beyond policy bound")]
    OraclePriceDeviationExceeded,
    #[msg("Limit price exceeds maximum allowed slippage bound")]
    SlippageBoundExceeded,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_sol_feed_id() -> [u8; 32] {
        [
            0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1,
            0xda, 0x39, 0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8,
            0xc2, 0x80, 0xb5, 0x6d,
        ]
    }

    fn build_price_update_v2(
        verification_tag: u8,
        raw_price: i64,
        raw_conf: u64,
        exponent: i32,
        publish_time: i64,
    ) -> Vec<u8> {
        let mut buf = vec![0u8; 134];
        buf[0..8].copy_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        buf[40] = verification_tag;
        let feed_offset = if verification_tag == 0 { 42 } else { 41 };
        buf[feed_offset..feed_offset + 32].copy_from_slice(&sample_sol_feed_id());
        let p_off = feed_offset + 32;
        buf[p_off..p_off + 8].copy_from_slice(&raw_price.to_le_bytes());
        buf[p_off + 8..p_off + 16].copy_from_slice(&raw_conf.to_le_bytes());
        buf[p_off + 16..p_off + 20].copy_from_slice(&exponent.to_le_bytes());
        buf[p_off + 20..p_off + 28].copy_from_slice(&publish_time.to_le_bytes());
        buf[p_off + 52..p_off + 60].copy_from_slice(&525_522_626u64.to_le_bytes());
        buf
    }

    fn build_drift_market(market_key: &Pubkey) -> Vec<u8> {
        let mut buf = vec![0u8; 320];
        buf[8..40].copy_from_slice(&market_key.to_bytes());
        buf
    }

    fn default_policy() -> RiskPolicy {
        RiskPolicy {
            authority: Pubkey::new_unique(),
            fixed_risk_cap_usdc_e6: 10_000_000, // $10.00 USDC
            max_conf_bps: 30,
            max_staleness_sec: 45,
            max_slippage_bps: 20,
            max_oracle_deviation_bps: 150, // 1.50% max venue-vs-Pyth reference deviation
            executed_count: 0,
            last_slot: 0,
            last_decision_digest: [0u8; 32],
            bump: 254,
        }
    }

    #[test]
    fn accepts_valid_long_and_short_perp_and_binary_prediction_orders() {
        let mut policy = default_policy();
        let market_key = pubkey!("8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W");
        let market_data = build_drift_market(&market_key);
        // $74.00000000 with $0.02000000 conf (2.7 bps)
        let pyth_data = build_price_update_v2(1, 7_400_000_000, 2_000_000, -8, 1_795_460_000);

        // 1. Valid LONG Perp ($800 notional * 125 bps stop = $10 max loss)
        let long_params = GuardedImpulseParams {
            expected_pyth_feed_id: sample_sol_feed_id(),
            sized_notional_usdc_e6: 800_000_000,
            stop_distance_bps: 125,
            reference_price_e6: 74_050_000,
            limit_price_e6: 74_190_000, // +18.9 bps <= 20 bps
            order_mode: OrderMode::IocLimit,
            trade_side: TradeSide::Long,
            market_kind: MarketKind::Perp,
            decision_digest: [7u8; 32],
        };
        let res = verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            525_528_000,
            1_795_460_005,
            &long_params,
        );
        assert!(res.is_ok());
        assert_eq!(policy.executed_count, 1);

        // 2. Valid SHORT Perp (selling into bid $73.95, limit $73.81 >= -20 bps)
        let short_params = GuardedImpulseParams {
            reference_price_e6: 73_950_000,
            limit_price_e6: 73_810_000,
            trade_side: TradeSide::Short,
            ..long_params.clone()
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            525_528_001,
            1_795_460_006,
            &short_params,
        )
        .is_ok());
        assert_eq!(policy.executed_count, 2);

        // 3. Valid low-priced Binary Prediction ($0.20 ask, $0.215 limit = +1.5c, $10 cap)
        let pm_key = pubkey!("7rUSt1PXXn2Pp4ZNDcZqZGEgKSGpxqbRyb2W6rG1Dtt6");
        let pm_data = build_drift_market(&pm_key);
        let pm_params = GuardedImpulseParams {
            expected_pyth_feed_id: sample_sol_feed_id(),
            sized_notional_usdc_e6: 10_000_000,
            stop_distance_bps: 10_000,
            reference_price_e6: 200_000, // 20.0c
            limit_price_e6: 215_000,     // 21.5c (+150 probability bps)
            order_mode: OrderMode::PostOnly,
            trade_side: TradeSide::Long,
            market_kind: MarketKind::BinaryPrediction,
            decision_digest: [9u8; 32],
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &pm_key,
            &DRIFT_V2_PROGRAM_ID,
            &pm_data,
            525_528_002,
            1_795_460_007,
            &pm_params,
        )
        .is_ok());
        assert_eq!(policy.executed_count, 3);
    }

    #[test]
    fn rejects_partial_verification_spoofed_reference_price_wrong_owner_and_blind_market() {
        let mut policy = default_policy();
        let market_key = pubkey!("8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W");
        let market_data = build_drift_market(&market_key);
        let pyth_full = build_price_update_v2(1, 7_400_000_000, 2_000_000, -8, 1_795_460_000);

        let base_params = GuardedImpulseParams {
            expected_pyth_feed_id: sample_sol_feed_id(),
            sized_notional_usdc_e6: 800_000_000,
            stop_distance_bps: 125,
            reference_price_e6: 74_050_000,
            limit_price_e6: 74_150_000,
            order_mode: OrderMode::IocLimit,
            trade_side: TradeSide::Long,
            market_kind: MarketKind::Perp,
            decision_digest: [1u8; 32],
        };

        // A. Reject BlindMarket order
        let blind = GuardedImpulseParams {
            order_mode: OrderMode::BlindMarket,
            ..base_params.clone()
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_full,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            1,
            1_795_460_005,
            &blind,
        )
        .is_err());

        // B. Reject VerificationLevel::Partial (tag = 0) & corrupted tag = 2
        let pyth_partial = build_price_update_v2(0, 7_400_000_000, 2_000_000, -8, 1_795_460_000);
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_partial,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            1,
            1_795_460_005,
            &base_params,
        )
        .is_err());

        // C. Reject caller spoofing inflated reference_price_e6 ($95 vs $74 Pyth raw_price)
        let spoofed_ref = GuardedImpulseParams {
            reference_price_e6: 95_000_000,
            limit_price_e6: 95_100_000,
            ..base_params.clone()
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_full,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            1,
            1_795_460_005,
            &spoofed_ref,
        )
        .is_err());

        // D. Reject non-Drift target market owner
        let fake_owner = Pubkey::new_unique();
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_full,
            &market_key,
            &fake_owner,
            &market_data,
            1,
            1_795_460_005,
            &base_params,
        )
        .is_err());
    }

    #[test]
    fn enforces_exact_integer_truncation_boundaries_for_73_18_and_stop_150_bps() {
        let mut policy = default_policy();
        let market_key = pubkey!("8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W");
        let market_data = build_drift_market(&market_key);
        // Pyth SOL/USD = $73.11790000 (`7_311_790_000` at exp `-8`), conf = $0.0204 (`2.8 bps`)
        let pyth_data = build_price_update_v2(1, 7_311_790_000, 2_040_000, -8, 1_795_460_000);

        // 1. LONG boundary at reference_price_e6 = 73_180_000 (`max_from_ref` = 73_326_360):
        //    - Rounded-up `73_326_400` ($73.3264) MUST revert with SlippageBoundExceeded
        //    - Floored `73_326_300` ($73.3263) MUST pass
        let bad_long = GuardedImpulseParams {
            expected_pyth_feed_id: sample_sol_feed_id(),
            sized_notional_usdc_e6: 800_000_000,
            stop_distance_bps: 125,
            reference_price_e6: 73_180_000,
            limit_price_e6: 73_326_400,
            order_mode: OrderMode::IocLimit,
            trade_side: TradeSide::Long,
            market_kind: MarketKind::Perp,
            decision_digest: [2u8; 32],
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            525_536_200,
            1_795_460_002,
            &bad_long,
        )
        .is_err());

        let good_long = GuardedImpulseParams {
            limit_price_e6: 73_326_300,
            ..bad_long.clone()
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            525_536_200,
            1_795_460_002,
            &good_long,
        )
        .is_ok());

        // 2. SHORT boundary at reference_price_e6 = 73_180_000 (`min_from_ref` = 73_033_640):
        //    - Rounded-down `73_033_600` ($73.0336) MUST revert with SlippageBoundExceeded
        //    - Ceiled `73_033_700` ($73.0337) MUST pass
        let bad_short = GuardedImpulseParams {
            limit_price_e6: 73_033_600,
            trade_side: TradeSide::Short,
            ..bad_long.clone()
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            525_536_201,
            1_795_460_003,
            &bad_short,
        )
        .is_err());

        let good_short = GuardedImpulseParams {
            limit_price_e6: 73_033_700,
            trade_side: TradeSide::Short,
            ..bad_long.clone()
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            525_536_201,
            1_795_460_003,
            &good_short,
        )
        .is_ok());

        // 3. Non-terminating stop_distance_bps = 150 (`$10 / 1.5% = 666.6666...`):
        //    - Rounded-up `666_670_000` ($666.67 => 100_000_500_000 > 100_000_000_000) MUST revert
        //    - Floored `666_660_000` ($666.66 => 99_999_000_000 <= 100_000_000_000) MUST pass
        let bad_notional = GuardedImpulseParams {
            sized_notional_usdc_e6: 666_670_000,
            stop_distance_bps: 150,
            limit_price_e6: 73_326_300,
            ..bad_long.clone()
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            525_536_202,
            1_795_460_004,
            &bad_notional,
        )
        .is_err());

        let good_notional = GuardedImpulseParams {
            sized_notional_usdc_e6: 666_660_000,
            stop_distance_bps: 150,
            limit_price_e6: 73_326_300,
            ..bad_long
        };
        assert!(verify_and_apply_guarded_impulse(
            &mut policy,
            &PYTH_SOLANA_RECEIVER_ID,
            &pyth_data,
            &market_key,
            &DRIFT_V2_PROGRAM_ID,
            &market_data,
            525_536_202,
            1_795_460_004,
            &good_notional,
        )
        .is_ok());
    }
}
