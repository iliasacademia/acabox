import React from 'react';
import { createRoot } from 'react-dom/client';
import './commandDesk.css';
import './components/find-bar/FindBar.css';
import { FindBar } from './components/find-bar/FindBar';

const root = createRoot(document.getElementById('root')!);
root.render(<FindBar api={window.findBarAPI} />);
