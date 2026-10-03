import {
  registrationActions,
  registrationDescription,
  registrationInput,
} from '../custom-registration/shared';
export const registerCustomRouteDefinition = {
  name: 'register_custom_route',
  title: 'Custom Route Registration',
  summary: 'Register and manage HTTP routes from saved workspace modules.',
  description: registrationDescription('route'),
  inputSchema: registrationInput,
  actions: [...registrationActions],
};
