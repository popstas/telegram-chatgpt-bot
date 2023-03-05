import * as yaml  from 'js-yaml';
import { readFileSync } from 'fs';

export type ConfigType = {
  auth: {
    bot_token: string
    chatgpt_api_key: string
  }
  settings: {
    temperature?: number
    top_p?: number
    debug: boolean
  }
  chats: {
    name: string
    id: number
    prefix?: string
  }[]
}

export function readConfig (path: string = 'config.yml') {
  console.log("path:", path);
  const config = yaml.load(readFileSync(path, 'utf8')) as ConfigType;
  return config;
}
