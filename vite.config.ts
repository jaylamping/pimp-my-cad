import { defineConfig } from 'vite';
import { step2glb } from './server/step2glb';

export default defineConfig({
  plugins: [step2glb()],
});
