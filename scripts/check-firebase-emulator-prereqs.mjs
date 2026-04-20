import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const FIREBASE_TOOLS_VERSION = '14.3.1';
const FIREBASE_CONFIG_PATH = 'functions/firebase.json';
const EMULATOR_TEST_PATH = 'src/adapters/uploads/FirebaseUploadService.emulator.test.ts';

function runCommand(command, args) {
  return spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function formatStderr(text) {
  return text?.trim() ? `\n${text.trim()}` : '';
}

function fail(lines) {
  console.error('Firebase emulator preflight failed.\n');
  for (const line of lines) {
    console.error(`- ${line}`);
  }
  process.exit(1);
}

function checkJava() {
  const result = runCommand('java', ['-version']);
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.code === 'ENOENT'
        ? 'Install Java (JRE/JDK) and ensure `java` is on your PATH.'
        : `java -version exited with status ${result.status}.${formatStderr(result.stderr)}`;
    fail([
      'Java runtime is required by Firestore emulator but was not available.',
      detail,
      'After installing Java, rerun: npm run test:uploads:firebase-emulator',
    ]);
  }
}

function checkNodeModules() {
  if (!fs.existsSync('node_modules')) {
    fail([
      'Root dependencies are missing (`node_modules` not found).',
      'Run `npm install` (or `npm ci`) from the AuraPix repo root, then rerun this command.',
    ]);
  }
}

function checkProjectFiles() {
  const missing = [FIREBASE_CONFIG_PATH, EMULATOR_TEST_PATH].filter((path) => !fs.existsSync(path));
  if (missing.length > 0) {
    fail([
      `Required project files are missing: ${missing.join(', ')}`,
      'Run this command from the AuraPix repo root and ensure your branch includes emulator test assets.',
    ]);
  }
}

function loadFirebaseEmulatorPorts() {
  const raw = fs.readFileSync(FIREBASE_CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const emulators = parsed.emulators ?? {};

  return Object.entries(emulators)
    .filter(([, value]) => typeof value === 'object' && value !== null && Number.isInteger(value.port))
    .map(([name, value]) => ({ name, port: value.port }));
}

function assertPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function checkConfiguredEmulatorPortsAvailable() {
  const configuredPorts = loadFirebaseEmulatorPorts();
  for (const emulator of configuredPorts) {
    const available = await assertPortAvailable(emulator.port);
    if (!available) {
      fail([
        `Configured emulator port is already in use: ${emulator.name} -> ${emulator.port}`,
        `Free the port or change ${FIREBASE_CONFIG_PATH} -> emulators.${emulator.name}.port, then rerun this command.`,
      ]);
    }
  }
}

function checkFirebaseTools() {
  const result = runCommand('npx', ['-y', `firebase-tools@${FIREBASE_TOOLS_VERSION}`, '--version']);
  if (result.error || result.status !== 0) {
    fail([
      `Unable to execute firebase-tools@${FIREBASE_TOOLS_VERSION} via npx.`,
      result.error?.message ?? `Command exited with status ${result.status}.${formatStderr(result.stderr)}`,
      'Check network access/npm registry settings, then rerun this command.',
    ]);
  }
}

async function main() {
  checkNodeModules();
  checkProjectFiles();
  checkJava();
  checkFirebaseTools();
  await checkConfiguredEmulatorPortsAvailable();
  console.log('Firebase emulator preflight passed (Java + firebase-tools + project files).');
}

await main();
