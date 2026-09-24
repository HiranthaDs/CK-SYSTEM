import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = process.cwd()
const virtualenvPython = process.platform === 'win32'
  ? join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe')
  : join(projectRoot, 'backend', '.venv', 'bin', 'python')
const python = existsSync(virtualenvPython)
  ? virtualenvPython
  : process.platform === 'win32' ? 'python' : 'python3'

const args = [
  '-m',
  'uvicorn',
  'app.main:app',
  '--app-dir',
  'backend',
  '--port',
  '8000',
]

if (process.argv.includes('--reload')) {
  args.push('--reload', '--reload-dir', 'backend')
}

const child = spawn(python, args, { stdio: 'inherit' })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(`Unable to start the Python API: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
