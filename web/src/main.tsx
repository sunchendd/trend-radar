import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root 不存在：index.html 被改坏了');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
