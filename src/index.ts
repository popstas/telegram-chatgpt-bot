import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { ChatGPTAPI } from 'chatgpt';
import { oraPromise } from 'ora';
// import { readConfig } from './readConfig'; // TODO: Cannot find module 'src/readConfig' imported from src/index.ts

import * as yaml  from 'js-yaml';
import { readFileSync } from 'fs';

type ConfigType = {
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
function readConfig (path: string = 'config.yml') {
  console.log("path:", path);
  const config = yaml.load(readFileSync(path, 'utf8')) as ConfigType;
  return config;
}
const config = readConfig();

const bot = new Telegraf(config.auth.bot_token);
console.log('bot started');
bot.on('text', onMessage);
bot.on('channel_post', onMessage);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
bot.launch();

const api = new ChatGPTAPI({
  apiKey: config.auth.chatgpt_api_key,
  completionParams: {
    temperature: config.settings.temperature,
    top_p: config.settings.top_p
  },
  debug: config.settings.debug,
});

const history: { [key: number]: Context[] } = {};

function addToHistory(msg: Context) {
  const key = msg.chat?.id || 0;
  if (!history[key]) {
    history[key] = [];
  }
  history[key].push(msg);
}

function getHistory(msg: Context) {
  return history[msg.chat?.id || 0] || [];
}

function getChatgptAnswer(msg: { text: string }) {
  if (!msg.text) return { text: '' };
  console.log("msg:", message);
  return oraPromise(api.sendMessage(msg.text));
}

async function onMessage(ctx: Context) {
  console.log("ctx:", ctx);
  if (!('message' in ctx)) {
    console.log('no text in message');
    return;
  }

  const chat = config.chats.find(c => c.id == ctx.chat?.id || 0);
  if (!chat) {
    console.log('Unknown chat: ', ctx.chat);
    return;
  }

  // console.log("ctx.message.text:", ctx.message?.text);
  const msg = ctx.message;
  // addToHistory(msg);

  if (chat.prefix) {
    const re = new RegExp(`^${chat.prefix}`, 'i');
    const isBot = re.test(/*msg.text ||*/ '');
    if (isBot) return;
  }

  const res = await getChatgptAnswer(msg as { text: string });
  console.log('res:', res);
  if (!ctx.message || !msg?.chat) return;
  return await ctx.telegram.sendMessage(msg.chat.id, res.text);
}
