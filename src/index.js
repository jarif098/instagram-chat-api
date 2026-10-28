'use strict';

const InstaChatClient = require('./client');
const Session = require('./auth/session');
const { createSessionFromCookieString, createSessionFromCookies } = require('./auth/credentials');
const Events = require('./constants/events');
const Endpoints = require('./constants/endpoints');
const errors = require('./utils/errors');
const { Logger } = require('./utils/logger');
const User = require('./models/user');
const Message = require('./models/message');
const Conversation = require('./models/conversation');
const ConversationsService = require('./services/conversations');
const ThreadsService = require('./services/threads');
const MessagesService = require('./services/messages');
const MediaService = require('./services/media');
const SharingService = require('./services/sharing');
const ReactionsService = require('./services/reactions');
const ReadReceiptsService = require('./services/read-receipts');
const ThemesService = require('./services/themes');
const NicknamesService = require('./services/nicknames');
const UsersService = require('./services/users');

module.exports = {
  InstaChatClient,
  Session,
  Events,
  Endpoints,
  ...errors,
  User,
  Message,
  Conversation,
  ConversationsService,
  ThreadsService,
  MessagesService,
  MediaService,
  SharingService,
  ReactionsService,
  ReadReceiptsService,
  ThemesService,
  NicknamesService,
  UsersService,
  createSessionFromCookieString,
  createSessionFromCookies,
  Logger
};
