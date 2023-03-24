import { ChatMessage } from 'chatgpt';
import { Message } from 'telegraf/types';

export type ConfigChatType = {
  name: string
  id: number
  prefix?: string
  progPrefix?: string
  progInfoPrefix?: string
  forgetPrefix?: string
  systemMessage?: string
  debug?: boolean
  memoryless?: boolean
}

export type ConfigType = {
  bot_name: string
  debug?: boolean
  auth: {
    bot_token: string
    chatgpt_api_key: string
  },
  systemMessage?: string
  timeoutMs?: number
  completionParams: {
    temperature?: number
    top_p?: number
  }
  allowedPrivateUsers?: string[]
  chats: ConfigChatType[]
}

export type ThreadStateType = {
  lastAnswer?: ChatMessage
  partialAnswer: string
  history: Message.TextMessage[]
  customSystemMessage?: string
}
