import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadTheme, applyTextSize, loadTextSize } from './theme';
import { startInstallSupport } from './install';
import { startHaptics } from './haptics';
import { dismissBootScreen } from './boot';
import './global.css';

startInstallSupport();
applyTheme(loadTheme());
applyTextSize(loadTextSize());
dismissBootScreen();
createRoot(document.getElementById('root')!).render(<App />);
startHaptics();
