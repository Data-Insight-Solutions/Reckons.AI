export interface TurtleChatMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: KBAction[];
}

export type GraphFilter = 'hubs' | 'islands' | 'confirmed' | 'pending' | 'no-type' | 'no-source';

export type KBAction =
  | { type: 'add_triple'; s: string; p: string; o: string; label: string }
  | { type: 'remove_triple'; s: string; p: string; o: string; label: string }
  | { type: 'set_type'; entityIri: string; entityLabel: string; typeIri: string; typeLabel: string }
  | { type: 'merge_entities'; keepEntityIri: string; keepEntityLabel: string; dropEntityIri: string; dropEntityLabel: string }
  | { type: 'confirm_source'; sourceId: string; sourceTitle: string }
  | { type: 'adjust_view'; selectEntity?: string; layout?: 'force' | 'focus' | 'source' | 'type' | 'hub'; filters?: GraphFilter[]; label: string }
  | { type: 'query_kb'; filter: 'no-type' | 'no-source' | 'pending' | 'islands'; label: string }
  | { type: 'scrape_url'; url: string; label: string };

export interface TurtleChatRequest {
  apiKey: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  kbContext: KBContext;
}

export interface KBContext {
  statementCount: number;
  sourceCount: number;
  typesPresent: string[];
  untypedEntityCount: number;
  manualStatementCount: number;
  sampleEntities: Array<{ iri: string; label: string; type: string | null; predicates: string[] }>;
}

export interface TurtleChatResponse {
  message: string;
  actions: KBAction[];
}
