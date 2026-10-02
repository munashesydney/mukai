import type { Agent, Message, Pursuit, Space } from './types';

export const agents: Agent[] = [
  {
    id: 'atlas',
    name: 'Atlas',
    role: 'Your strategist',
    description: 'Keeps the big picture in focus and your pursuits moving forward.',
    color: 'teal',
  },
  {
    id: 'nova',
    name: 'Nova',
    role: 'Your builder',
    description: 'Turns the next good idea into something you can actually use.',
    color: 'purple',
  },
  {
    id: 'scout',
    name: 'Scout',
    role: 'Your explorer',
    description: 'Finds opportunities, connects the dots, and brings back the useful bits.',
    color: 'amber',
  },
];
export const initialSpaces: Space[] = [
  {
    id: 'ai-telegram-copier',
    name: 'ai-telegram-copier',
    description: 'Small steps. A better product. A growing business.',
  },
  {
    id: 'cubey',
    name: 'cubey',
    description: 'Building a little robot with a big sense of curiosity.',
    unread: 2,
  },
  {
    id: 'experiments',
    name: 'experiments',
    description: 'A home for ideas that aren’t quite ready to be a plan.',
  },
];
export const initialPursuits: Pursuit[] = [
  {
    id: 'grow-mrr',
    name: 'Grow MRR to $2,000',
    agent: 'atlas',
    description:
      'Grow AI Telegram Copier to $2,000 in monthly recurring revenue by the end of 2027.',
    progress: 53,
  },
  {
    id: 'map-room',
    name: 'Help Cubey map a room',
    agent: 'nova',
    description: 'Give Cubey the confidence to find its way around a room.',
    progress: 28,
  },
  {
    id: 'business-idea',
    name: 'Explore a business idea',
    agent: 'scout',
    description: 'Find a problem worth solving. Start with the people who have it.',
    progress: 15,
  },
  {
    id: 'japanese',
    name: 'Learn Japanese',
    agent: 'atlas',
    description: 'Make a little time each day to learn something new.',
    progress: 12,
    paused: true,
  },
];
export const initialMessages: Record<string, Message[]> = {
  'ai-telegram-copier': [
    {
      id: 'home-1',
      author: 'munashe',
      time: '10:14 AM',
      text: 'Let’s get MRR to $2,000 by the end of 2027. 🚀',
      reaction: '🚀',
    },
    {
      id: 'home-2',
      author: 'atlas',
      time: '10:15 AM',
      text: 'On it. I’ll keep this moving and check in when there’s something useful.',
      card: 'pursuit',
    },
    {
      id: 'home-3',
      author: 'nova',
      time: '10:28 AM',
      text: 'I noticed a few users getting stuck during setup. I’m putting together a simpler guide—three steps, less friction.',
      card: 'draft',
    },
    {
      id: 'home-4',
      author: 'munashe',
      time: '10:32 AM',
      text: 'Nice, go for it. Keep it simple. 👌',
    },
  ],
  cubey: [
    {
      id: 'cubey-1',
      author: 'munashe',
      time: '9:20 AM',
      text: 'Let’s help Cubey figure out where it is in the room.',
    },
    {
      id: 'cubey-2',
      author: 'nova',
      time: '9:24 AM',
      text: 'A good place to start: one room, a few landmarks, and a simple map. We can build from there.',
    },
  ],
  experiments: [
    {
      id: 'experiment-1',
      author: 'scout',
      time: 'Yesterday',
      text: 'Every good thing starts with a “what if.” Drop your ideas here and we’ll explore them together.',
    },
  ],
  nova: [
    {
      id: 'nova-1',
      author: 'munashe',
      time: '10:20 AM',
      text: 'Can you make the setup guide simpler?',
    },
    {
      id: 'nova-2',
      author: 'nova',
      time: '10:21 AM',
      text: 'Yep. I’ll make it a short walkthrough with screenshots.',
    },
    {
      id: 'nova-3',
      author: 'nova',
      time: '10:28 AM',
      text: 'Here’s the first draft. I kept it to three steps.',
      card: 'draft',
    },
    {
      id: 'nova-4',
      author: 'munashe',
      time: '10:32 AM',
      text: 'Perfect. Remember to keep the tone casual.',
    },
    {
      id: 'nova-5',
      author: 'nova',
      time: '10:33 AM',
      text: 'Got it. Short, useful, and a little more human.',
    },
  ],
  atlas: [
    {
      id: 'atlas-1',
      author: 'atlas',
      time: '9:15 AM',
      text: 'Morning, Munashe. We’re at $1,062 MRR. This week, a smoother setup experience is the most useful next step.',
      card: 'pursuit',
    },
    {
      id: 'atlas-2',
      author: 'munashe',
      time: '9:18 AM',
      text: 'Sounds good. Let’s make that the focus.',
    },
  ],
  scout: [
    {
      id: 'scout-1',
      author: 'scout',
      time: '8:45 AM',
      text: 'I’ve been exploring the ideas in your workspace. There are a few interesting threads to pull on. Where would you like to start?',
    },
  ],
  'grow-mrr': [
    {
      id: 'pursuit-1',
      author: 'munashe',
      time: '9:14 AM',
      text: 'Grow AI Telegram Copier to $2,000 MRR by the end of 2027.',
    },
    {
      id: 'pursuit-2',
      author: 'atlas',
      time: '9:15 AM',
      text: 'We’re at $1,062. This week I’m focusing on making setup easier.',
    },
    {
      id: 'pursuit-3',
      author: 'atlas',
      time: '9:16 AM',
      text: 'Nova has a draft ready. Want to take a look?',
      card: 'draft',
    },
  ],
};
