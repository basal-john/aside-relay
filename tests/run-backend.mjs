import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const python = process.env.ASIDE_TEST_PYTHON || (existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3');
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests/backend', '-p', 'test_*.py', '-v'], { stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
