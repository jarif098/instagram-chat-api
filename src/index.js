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
const Note = require('./models/note');
const Post = require('./models/post');
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
const NotesService = require('./services/notes');
const PostsService = require('./services/posts');
const { NOTE_AUDIENCES, REACTION_ALIASES } = require('./utils/validators');

module.exports = {
  InstaChatClient,
  Session,
  Events,
  Endpoints,
  ...errors,
  User,
  Message,
  Conversation,
  Note,
  Post,
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
  NotesService,
  PostsService,
  NOTE_AUDIENCES,
  NoteAudience: NOTE_AUDIENCES,
  REACTION_ALIASES,
  createSessionFromCookieString,
  createSessionFromCookies,
  Logger
};
