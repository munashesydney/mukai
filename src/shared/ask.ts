export interface AskOption {
  label: string;
  description?: string;
  recommended: boolean;
}

export interface AskInput {
  action: 'clarification' | 'approval';
  question: string;
  options?: AskOption[];
}

export type AskResponse =
  { action: 'clarification'; answer: string } | { action: 'approval'; approved: boolean };
