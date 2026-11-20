import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// getUserMedia requires a secure context: serve over HTTPS (self-signed certificate) and listen on
// every interface so a phone on the same network can open the playground.
export default defineConfig({
  plugins: [basicSsl({ name: 'ouaf-playground' })],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { target: 'es2023' },
})
