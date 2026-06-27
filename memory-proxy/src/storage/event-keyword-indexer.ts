import { runAndPersist } from './db.js';
import { tokenize } from './keyword-tokenizer.js';

/**
 * Index an event's description into event_keywords.
 * Called after an event is inserted.
 */
export function indexEventKeywords(eventId: string, description: string): void {
  const keywords = tokenize(description).filter(k => k.length >= 1 && k.length <= 20);
  if (keywords.length === 0) return;

  const placeholders = keywords.map(() => '(?, ?)').join(', ');
  const params: (string | null)[] = [];
  for (const kw of keywords) {
    params.push(eventId, kw);
  }

  runAndPersist(
    `INSERT OR IGNORE INTO event_keywords (event_id, keyword) VALUES ${placeholders}`,
    params
  );
}

/**
 * Remove all keyword entries for an event.
 */
export function deleteEventKeywords(eventId: string): void {
  runAndPersist('DELETE FROM event_keywords WHERE event_id = ?', [eventId]);
}
