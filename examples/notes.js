'use strict';

/**
 * Example: Managing Instagram Direct Notes
 */

const { InstaChatClient, NoteAudience } = require('../src');

async function main() {
  const client = new InstaChatClient();

  await client.connect();

  console.log('\n--- Fetching Active Notes from Inbox ---');
  const notes = await client.getNotes();
  console.log(`Found ${notes.length} active note(s) in your Direct tray:\n`);

  for (const note of notes) {
    const author = note.user ? `@${note.user.username}` : note.userId;
    const marker = note.isSelf ? ' (You)' : '';
    console.log(`• [${author}${marker}]: "${note.text}" [${note.audienceName}] (Expires in ${Math.round(note.remainingMs / 1000 / 60)} min)`);
    if (note.media) {
      console.log(`  🎵 Track: ${note.media.title} - ${note.media.artist}`);
    }
  }

  // 1. Post a new Note
  console.log('\n--- Creating a Note ---');
  const newNote = await client.createNote('Building open-source tools with Node.js 🚀', {
    audience: NoteAudience.MUTUAL_FOLLOWERS
  });
  console.log(`Created note: "${newNote.text}" (ID: ${newNote.id})`);

  // 2. Fetch viewer's active note
  const myNote = await client.getMyNote();
  console.log(`My active note: "${myNote ? myNote.text : 'None'}"`);

  // 3. Like a note (example)
  if (notes.length > 0 && !notes[0].isSelf) {
    console.log(`\nLiking note by @${notes[0].user?.username}...`);
    await client.likeNote(notes[0].id);
    console.log('Liked note successfully!');
  }

  // 4. Clean up / delete note
  console.log('\n--- Deleting Note ---');
  await client.deleteNote();
  console.log('Deleted active note successfully!');

  await client.disconnect();
}

if (require.main === module) {
  main().catch(console.error);
}
