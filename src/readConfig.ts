import * as yaml  from 'js-yaml';
import { readFileSync } from 'fs';
import { ConfigType } from './types.js';

export function readConfig (path: string = 'config.yml'): ConfigType {
  const config = yaml.load(readFileSync(path, 'utf8'));
  return config as ConfigType;
}
