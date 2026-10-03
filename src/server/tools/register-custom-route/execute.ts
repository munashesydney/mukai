import {
  executeRegistration,
  type RegistrationContext,
  registrationInput,
} from '../custom-registration/shared';
import type { z } from 'zod';
export function executeRegisterCustomRoute(
  input: z.infer<typeof registrationInput>,
  context: RegistrationContext,
  toolCallId: string,
) {
  return executeRegistration('route', input, context, toolCallId);
}
