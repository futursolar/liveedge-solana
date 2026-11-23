import './ui/styles.css';
import { LiveEdgeSolanaApp } from './ui/app';

const container = document.querySelector<HTMLElement>('#app');
if (!container) {
  throw new Error('Missing #app mount element');
}

const app = new LiveEdgeSolanaApp(container);
void app.mount();
