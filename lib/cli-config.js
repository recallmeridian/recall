'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  serverUrl: '',
  apiKey: '',
  defaultProject: '',
  llm: {
    provider: '',
    baseUrl: '',
    model: '',
    apiKey: ''
  }
};

function getDataDir() {
  return process.env.MERIDIAN_DATA || process.env.MERIDIAN_DATA_DIR || path.join(os.homedir(), '.meridian');
}

function getConfigPath() {
  return path.join(getDataDir(), 'cli-config.json');
}

function ensureDir() {
  fs.mkdirSync(getDataDir(), { recursive: true });
}

function read() {
  ensureDir();
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function write(config) {
  ensureDir();
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

function get(key) {
  const config = read();
  return config[key];
}

function set(key, value) {
  const config = read();
  config[key] = value;
  write(config);
}

module.exports = {
  read,
  write,
  get,
  set,
  getDataDir,
  getConfigPath,
  get CONFIG_PATH() {
    return getConfigPath();
  },
};
