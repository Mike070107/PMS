import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Reports from '../src/pages/Reports';
import { IconSprite } from '../src/components/Icon';
import './erp-browser-auth';
import '../src/styles/design.css';
import '../src/styles/app.css';
import '../src/styles/large.css';
import '../src/styles/calendar.css';
import '../src/styles/erp-reference.css';

createRoot(document.getElementById('root')!).render(
  <><IconSprite />
    <MemoryRouter initialEntries={['/reports']}>
      <Routes><Route path="/reports" element={<Reports />} /></Routes>
    </MemoryRouter>
  </>,
);
