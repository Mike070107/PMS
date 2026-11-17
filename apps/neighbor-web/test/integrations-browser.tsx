import { createRoot } from 'react-dom/client';
import Devices from '../src/pages/Devices';
import { IconSprite } from '../src/components/Icon';
import '../src/styles/design.css';
import '../src/styles/app.css';
import '../src/styles/large.css';
import '../src/styles/guards.css';
createRoot(document.getElementById('root')!).render(<><IconSprite /><main style={{ maxWidth: 1200, padding: 16, margin: 'auto' }}><Devices /></main></>);
