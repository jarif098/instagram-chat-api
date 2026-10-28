'use strict';

/**
 * Example: Uploading and Sending Image, Video, and Audio Attachments
 */

const path = require('path');
const { InstaChatClient } = require('../src');

async function main() {
  const client = new InstaChatClient();

  await client.connect();

  const targetThreadId = process.env.TARGET_THREAD_ID || '12345678901234567';

  // 1. Send Photo
  const imagePath = path.resolve(__dirname, './sample.jpg');
  console.log(`Sending image ${imagePath}...`);
  try {
    const photoMsg = await client.sendImage(targetThreadId, imagePath);
    console.log(`Image sent successfully! Item ID: ${photoMsg.id}`);
  } catch (err) {
    console.warn(`Could not send image: ${err.message}`);
  }

  // 2. Send Video
  const videoPath = path.resolve(__dirname, './sample.mp4');
  try {
    console.log(`Sending video ${videoPath}...`);
    const videoMsg = await client.sendVideo(targetThreadId, videoPath);
    console.log(`Video sent successfully! Item ID: ${videoMsg.id}`);
  } catch (err) {
    console.warn(`Could not send video: ${err.message}`);
  }

  // 3. Send Voice Note / Audio
  const audioPath = path.resolve(__dirname, './sample.mp3');
  try {
    console.log(`Sending audio ${audioPath}...`);
    const audioMsg = await client.sendAudio(targetThreadId, audioPath);
    console.log(`Audio sent successfully! Item ID: ${audioMsg.id}`);
  } catch (err) {
    console.warn(`Could not send audio: ${err.message}`);
  }

  await client.disconnect();
}

if (require.main === module) {
  main().catch(console.error);
}
