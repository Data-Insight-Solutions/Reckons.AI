/**
 * Tracks entity disambiguation suggestions from semantic similarity clustering.
 * When ingesting causes cluster collisions, suggestions are added here.
 * The UI can dismiss suggestions or trigger merges.
 */

export interface DisambiguationSuggestion {
  id: string;
  entityKeyA: string;
  entityKeyB: string;
  similarity: number;
  timestamp: number;
  dismissed: boolean;
}

let _suggestions = $state<DisambiguationSuggestion[]>([]);

export function suggestions(): DisambiguationSuggestion[] {
  return _suggestions.filter(s => !s.dismissed);
}

export function addSuggestion(s: DisambiguationSuggestion) {
  // Avoid duplicates
  const exists = _suggestions.some(
    (existing) =>
      !existing.dismissed &&
      ((existing.entityKeyA === s.entityKeyA && existing.entityKeyB === s.entityKeyB) ||
        (existing.entityKeyA === s.entityKeyB && existing.entityKeyB === s.entityKeyA))
  );
  if (!exists) {
    _suggestions = [..._suggestions, s];
  }
}

export function dismissSuggestion(id: string) {
  _suggestions = _suggestions.map((s) =>
    s.id === id ? { ...s, dismissed: true } : s
  );
}

export function clearAllSuggestions() {
  _suggestions = [];
}
