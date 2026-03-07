import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('public/quizzes', { recursive: true });
mkdirSync('public/visualizations', { recursive: true });

const htmlFilter = (f) => f.endsWith('.html') || !f.includes('.');

cpSync('quizzes', 'public/quizzes', { recursive: true, filter: htmlFilter });
cpSync('visualizations', 'public/visualizations', { recursive: true, filter: htmlFilter });
