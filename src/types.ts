import { ChatMessage } from 'chatgpt'
import { Message } from 'telegraf/types'
import { ServiceAccountCredentials } from 'google-spreadsheet'

export type ButtonsSyncConfigType = {
  sheetId: string
  sheetName: string
  auth: ServiceAccountCredentials
}

export type ConfigChatType = {
  name: string
  id: number
  username?: string
  prefix?: string
  progPrefix?: string
  progInfoPrefix?: string
  forgetPrefix?: string
  systemMessage?: string
  completionParams?: CompletionParamsType
  debug?: boolean
  memoryless?: boolean
  buttons?: ConfigChatButtonType[]
  buttonsSync: ButtonsSyncConfigType
  buttonsSynced: ConfigChatButtonType[]
}

export type GPTFunction = {
  name: string
  description: string
  parameters: {
    type: 'object',
    properties: {
      [key: string]: {
        type: string
        description: string
      }
    }
    required: string[]
  }
}

export type CompletionParamsType = {
  model: string
  temperature?: number
  top_p?: number
  presence_penalty?: number
  max_tokens: number
  functions: GPTFunction[]
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
  completionParams: CompletionParamsType
  allowedPrivateUsers?: string[]
  chats: ConfigChatType[]
}

export type ThreadStateType = {
  lastAnswer?: ChatMessage
  partialAnswer: string
  history: Message.TextMessage[]
  customSystemMessage?: string
  completionParams?: CompletionParamsType
  activeButton?: ConfigChatButtonType
  nextSystemMessage?: string
}

export type ConfigChatButtonType = {
  name: string
  prompt: string
  row?: number
  waitMessage?: string
}