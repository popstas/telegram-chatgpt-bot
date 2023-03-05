import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { Message } from 'telegraf/types';
import { ChatGPTAPI, ChatMessage } from 'chatgpt';
import { oraPromise } from 'ora';
import debounce from "lodash.debounce";
import throttle from "lodash.throttle";
import { watchFile } from 'fs';
// import { readConfig } from './readConfig'; // TODO: Cannot find module 'src/readConfig' imported from src/index.ts

import * as yaml  from 'js-yaml';
import { readFileSync } from 'fs';

type ConfigType = {
  debug?: boolean
  auth: {
    bot_token: string
    chatgpt_api_key: string
  }
  completionParams: {
    temperature?: number
    top_p?: number
  }
  chats: {
    name: string
    id: number
    prefix?: string
  }[]
}
function readConfig (path: string = 'config.yml') {
  const config = yaml.load(readFileSync(path, 'utf8')) as ConfigType;
  return config;
}
const configPath = 'config.yml';
let config = readConfig(configPath);
watchFile(configPath, debounce(() => {
  console.log("reload config...");
  config = readConfig(configPath);
  console.log("config:", config);
}, 2000));

const bot = new Telegraf(config.auth.bot_token);
console.log('bot started');
bot.on('text', onMessage);
bot.on('channel_post', onMessage);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
bot.launch();

const api = new ChatGPTAPI({
  apiKey: config.auth.chatgpt_api_key,
  completionParams: config.completionParams,
  debug: config.debug,
});

const history: { [key: number]: Message.TextMessage[] } = {};

let lastAnswer = {} as ChatMessage | undefined;

function addToHistory(msg: Message.TextMessage) {
  const key = msg.chat?.id || 0;
  if (!history[key]) {
    history[key] = [];
  }
  history[key].push(msg);
}

function getHistory(msg: Context) {
  return history[msg.chat?.id || 0] || [];
}

function getChatgptAnswer(msg: Message.TextMessage) {
  if (!msg.text) return;
  return oraPromise(
    api.sendMessage(msg.text, {
      name: msg.from?.username, // TODO: user name from telegram
      parentMessageId: lastAnswer?.id,
      onProgress: throttle(() => {
        bot.telegram.sendChatAction(msg.chat.id, 'typing');
      }, 5000),
    }),
    {
      text: 'ChatGPT request...'
    },
  );
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
  const msg = ctx.message as Message.TextMessage;
  // addToHistory(msg);

  if (chat.prefix) {
    const re = new RegExp(`^${chat.prefix}`, 'i');
    const isBot = re.test(msg.text || '');
    if (!isBot) return;
  }

  const res = await getChatgptAnswer(msg);
  console.log('res:', res);
  lastAnswer = res;
  // if (!ctx.message || !msg.chat) return;
  return await ctx.telegram.sendMessage(msg.chat.id, res?.text || 'бот не ответил');
}
