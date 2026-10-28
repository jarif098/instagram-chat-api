'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const InstaChatClient = require('../../src/client');

test('client._resolveAttachmentType: accurately identifies image, audio, and video', () => {
  const client = new InstaChatClient({ cookies: { sessionid: 's', csrftoken: 'c', ds_user_id: '123' } });

  assert.equal(client._resolveAttachmentType('song.mp3'), 'audio');
  assert.equal(client._resolveAttachmentType('voice.m4a'), 'audio');
  assert.equal(client._resolveAttachmentType('audio.wav'), 'audio');
  assert.equal(client._resolveAttachmentType('track.ogg'), 'audio');
  assert.equal(client._resolveAttachmentType('movie.mp4'), 'video');
  assert.equal(client._resolveAttachmentType('clip.mov'), 'video');
  assert.equal(client._resolveAttachmentType('photo.jpg'), 'image');
  assert.equal(client._resolveAttachmentType('pic.png'), 'image');

  assert.equal(client._resolveAttachmentType(null, { isAudio: true }), 'audio');
  assert.equal(client._resolveAttachmentType(null, { isVideo: true }), 'video');
  assert.equal(client._resolveAttachmentType(null, { isImage: true }), 'image');
});

test('client.sendMessage: sends combined { body, attachment } payload with Stream', async () => {
  const client = new InstaChatClient({ cookies: { sessionid: 's', csrftoken: 'c', ds_user_id: '123' } });
  let audioSent = false;
  let textSent = false;

  client.sendAudio = async (threadId, stream, opts) => {
    audioSent = true;
    return { id: 'mid.$audio_1', threadId, type: 'audio' };
  };
  client.messages.sendTextMessage = async (threadId, text, opts) => {
    textSent = true;
    return { id: 'mid.$text_1', threadId, text };
  };

  const fakeStream = Readable.from(['audio chunk 1']);
  const res = await client.sendMessage('th_1', {
    body: 'Listen to this track',
    attachment: fakeStream,
    isAudio: true
  });

  assert.equal(audioSent, true);
  assert.equal(textSent, true);
  assert.ok(res);
  assert.equal(res.id, 'mid.$text_1');
  assert.equal(res.body, 'Listen to this track');
});

test('client.sendMessage: sends multiple attachments array', async () => {
  const client = new InstaChatClient({ cookies: { sessionid: 's', csrftoken: 'c', ds_user_id: '123' } });
  const sentItems = [];

  client.sendImage = async (threadId, item) => {
    sentItems.push(item);
    return { id: `mid.$img_${sentItems.length}` };
  };

  await client.sendMessage('th_1', {
    attachments: ['photo1.jpg', 'photo2.png']
  });

  assert.equal(sentItems.length, 2);
  assert.equal(sentItems[0], 'photo1.jpg');
  assert.equal(sentItems[1], 'photo2.png');
});

test('client.reply: sets replyToItemId on attachment and cleanly sends caption', async () => {
  const client = new InstaChatClient({ cookies: { sessionid: 's', csrftoken: 'c', ds_user_id: '123' } });
  let replyOpts = null;

  client.sendImage = async (threadId, file, opts) => {
    replyOpts = opts;
    return { id: 'mid.$rep_img_1' };
  };

  await client.reply('th_1', 'mid.$orig_1', {
    attachment: 'meme.jpg'
  });

  assert.ok(replyOpts);
  assert.equal(replyOpts.replyToItemId, 'mid.$orig_1');
});
