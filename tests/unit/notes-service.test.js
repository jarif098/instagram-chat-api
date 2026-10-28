'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const NotesService = require('../../src/services/notes');
const Note = require('../../src/models/note');
const InstaChatClient = require('../../src/client');
const { ValidationError, NotFoundError } = require('../../src/utils/errors');
const { validateNoteText, validateNoteAudience } = require('../../src/utils/validators');

test('Note model: normalizes text, author, timestamps, audience, and media', () => {
  const rawNote = {
    id: '17992019283819283',
    text: 'Coding late at night 🌙',
    user_id: '65842145265',
    created_at: 1729000000,
    expires_at: 1729086400,
    audience: 0,
    is_liked_by_viewer: false,
    like_count: 5,
    user: {
      pk: '65842145265',
      username: 'eijah.noah',
      full_name: 'Eijah Noah',
      profile_pic_url: 'https://cdn.instagram.com/avatar.jpg'
    },
    music_info: {
      title: 'Midnight City',
      artist_name: 'M83',
      audio_cluster_id: '998877'
    }
  };

  const note = Note.fromRaw(rawNote, '65842145265');
  assert.equal(note.id, '17992019283819283');
  assert.equal(note.text, 'Coding late at night 🌙');
  assert.equal(note.userId, '65842145265');
  assert.equal(note.isSelf, true);
  assert.equal(note.audience, 0);
  assert.equal(note.audienceName, 'mutual_followers');
  assert.equal(note.likeCount, 5);
  assert.ok(note.user);
  assert.equal(note.user.username, 'eijah.noah');
  assert.ok(note.media);
  assert.equal(note.media.type, 'music');
  assert.equal(note.media.title, 'Midnight City');
  assert.equal(note.media.artist, 'M83');

  const json = note.toJSON();
  assert.equal(json.text, 'Coding late at night 🌙');
  assert.equal(json.audienceName, 'mutual_followers');
});

test('Validators: validateNoteText and validateNoteAudience', () => {
  assert.equal(validateNoteText('  Listening to lo-fi  '), 'Listening to lo-fi');
  assert.throws(() => validateNoteText(''), ValidationError);
  assert.throws(() => validateNoteText('   '), ValidationError);
  assert.throws(() => validateNoteText('a'.repeat(61)), ValidationError);

  assert.equal(validateNoteAudience(0), 0);
  assert.equal(validateNoteAudience('mutual'), 0);
  assert.equal(validateNoteAudience('followers'), 0);
  assert.equal(validateNoteAudience(1), 1);
  assert.equal(validateNoteAudience('close_friends'), 1);
  assert.equal(validateNoteAudience('close'), 1);
});

test('NotesService: getNotes parses inbox tray items and filters by user', async () => {
  const mockTransport = {
    get: async (url) => {
      return {
        data: {
          items: [
            {
              id: 'note_1',
              text: 'Good morning!',
              user_id: '100',
              audience: 0,
              user: { pk: '100', username: 'alice' }
            },
            {
              id: 'note_2',
              text: 'Coffee time ☕',
              user_id: '200',
              audience: 1,
              user: { pk: '200', username: 'bob' }
            }
          ]
        }
      };
    }
  };

  const service = new NotesService({
    transport: mockTransport,
    session: { userId: '100', getCsrfToken: () => 'csrf_token' }
  });

  const { notes } = await service.getNotes();
  assert.equal(notes.length, 2);
  assert.equal(notes[0].text, 'Good morning!');
  assert.equal(notes[0].isSelf, true);
  assert.equal(notes[1].text, 'Coffee time ☕');
  assert.equal(notes[1].isSelf, false);

  const myNote = await service.getMyNote();
  assert.ok(myNote);
  assert.equal(myNote.id, 'note_1');
  assert.equal(myNote.text, 'Good morning!');

  const bobNote = await service.getNoteByUser('bob');
  assert.ok(bobNote);
  assert.equal(bobNote.id, 'note_2');

  const missingNote = await service.getNoteByUser('charlie');
  assert.equal(missingNote, null);
});

test('NotesService: createNote sends formatted payload and returns Note', async () => {
  let postUrl = '';
  let postBody = '';

  const mockTransport = {
    post: async (url, body) => {
      postUrl = url;
      postBody = body;
      return {
        data: {
          status: 'ok',
          note: {
            id: 'note_new_123',
            text: 'Exploring the stars ✨',
            audience: 0,
            created_at: 1729000500,
            expires_at: 1729086900
          }
        }
      };
    }
  };

  const service = new NotesService({
    transport: mockTransport,
    session: { userId: '100', getCsrfToken: () => 'tok_csrf' }
  });

  const created = await service.createNote('Exploring the stars ✨', { audience: 'mutual' });
  assert.ok(created);
  assert.equal(created.id, 'note_new_123');
  assert.equal(created.text, 'Exploring the stars ✨');
  assert.equal(created.audience, 0);
  assert.ok(postUrl.includes('/api/v1/notes/create_note/'));
  assert.ok(postBody.includes('text=Exploring+the+stars'));
  assert.ok(postBody.includes('_csrftoken=tok_csrf'));
});

test('NotesService: deleteNote deletes specific note or current active note', async () => {
  const deletedIds = [];
  const mockTransport = {
    get: async () => ({
      data: {
        items: [
          { id: 'note_my_active', text: 'Active thought', user_id: '100' }
        ]
      }
    }),
    post: async (url, body) => {
      const params = new URLSearchParams(body);
      deletedIds.push(params.get('id'));
      return { data: { status: 'ok' } };
    }
  };

  const service = new NotesService({
    transport: mockTransport,
    session: { userId: '100', getCsrfToken: () => 'csrf' }
  });

  // Explicit ID delete
  const res1 = await service.deleteNote('note_999');
  assert.equal(res1.success, true);
  assert.equal(res1.noteId, 'note_999');

  // Auto-resolved viewer note delete
  const res2 = await service.deleteNote();
  assert.equal(res2.success, true);
  assert.equal(res2.noteId, 'note_my_active');
  assert.deepEqual(deletedIds, ['note_999', 'note_my_active']);
});

test('NotesService: likeNote and unlikeNote', async () => {
  const calls = [];
  const mockTransport = {
    post: async (url) => {
      calls.push(url);
      return { data: { status: 'ok' } };
    }
  };

  const service = new NotesService({
    transport: mockTransport,
    session: { getCsrfToken: () => 'csrf' }
  });

  const liked = await service.likeNote('note_555');
  assert.equal(liked.success, true);
  assert.equal(liked.liked, true);
  assert.ok(calls[0].includes('/api/v1/notes/note_555/like/'));

  const unliked = await service.unlikeNote('note_555');
  assert.equal(unliked.success, true);
  assert.equal(unliked.liked, false);
  assert.ok(calls[1].includes('/api/v1/notes/note_555/unlike/'));
});

test('NotesService: replyToNote sends contextual DM to note creator', async () => {
  let sentText = '';
  let sentThread = '';

  const mockNotesTransport = {
    get: async () => ({
      data: {
        items: [
          {
            id: 'note_author_1',
            text: 'Need movie recommendations',
            user_id: '400',
            user: { pk: '400', username: 'cinephile' }
          }
        ]
      }
    })
  };

  const mockConversations = {
    findByUsername: async (username) => {
      if (username === 'cinephile') return { id: 'th_cine_101' };
      return null;
    }
  };

  const mockMessages = {
    sendTextMessage: async (threadId, text) => {
      sentThread = threadId;
      sentText = text;
      return { id: 'mid.$reply_note_1', threadId, text };
    }
  };

  const service = new NotesService({
    transport: mockNotesTransport,
    session: { userId: '100' },
    conversationsService: mockConversations,
    messagesService: mockMessages
  });

  const sent = await service.replyToNote('note_author_1', 'Watch Interstellar!');
  assert.ok(sent);
  assert.equal(sentThread, 'th_cine_101');
  assert.ok(sentText.includes('Need movie recommendations'));
  assert.ok(sentText.includes('Watch Interstellar!'));
});

test('InstaChatClient: exposes NotesService methods and audience constants on facade', () => {
  const client = new InstaChatClient({ cookies: { sessionid: 's', csrftoken: 'c', ds_user_id: '123' } });

  assert.equal(typeof client.getNotes, 'function');
  assert.equal(typeof client.getMyNote, 'function');
  assert.equal(typeof client.getNoteByUser, 'function');
  assert.equal(typeof client.createNote, 'function');
  assert.equal(typeof client.deleteNote, 'function');
  assert.equal(typeof client.likeNote, 'function');
  assert.equal(typeof client.unlikeNote, 'function');
  assert.equal(typeof client.replyToNote, 'function');

  assert.ok(client.notes instanceof NotesService);
});
