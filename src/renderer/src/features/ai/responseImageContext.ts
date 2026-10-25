import { createContext } from 'react';
import type { ResponseImage } from './responseImages';

export const ResponseImageContext = createContext<{
  images: ResponseImage[];
  reveal: (key: string) => void;
} | null>(null);
