import {
  executeRegistration,
  type RegistrationContext,
  registrationInput,
} from '../custom-registration/shared';
import type { z } from 'zod';
export function executeRegisterCustomTool(
  input: z.infer<typeof registrationInput>,
  context: RegistrationContext,
  toolCallId: string,
) {
  return executeRegistration('tool', input, context, toolCallId);
}
