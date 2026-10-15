/**
 * Widely used npm packages. A new dependency one edit away from one of these (but not one of
 * these) is treated as a typosquat. Popular packages that are themselves near each other
 * (react/preact, qs/ws) are both listed, so neither is flagged.
 */
export const POPULAR_PACKAGES = new Set<string>(
  `react react-dom react-router react-router-dom preact vue svelte solid-js angular lit next nuxt remix astro vite
webpack rollup esbuild parcel babel-core @babel/core @babel/preset-env typescript tslib ts-node tsx
lodash lodash-es underscore ramda immer immutable rxjs zod yup joi ajv valibot superstruct
axios got ky node-fetch cross-fetch undici request superagent ws qs uuid nanoid cuid ulid
express koa fastify hapi hono connect body-parser cookie cookie-parser cors helmet morgan compression
chalk kleur picocolors colors debug ms dayjs moment date-fns luxon chrono-node
commander yargs minimist meow inquirer prompts ora listr execa shelljs cross-env dotenv
glob globby fast-glob minimatch micromatch chokidar rimraf mkdirp fs-extra graceful-fs del
classnames clsx tailwind-merge tailwindcss postcss autoprefixer sass less styled-components @emotion/react
framer-motion motion gsap three d3 chart.js recharts echarts leaflet mapbox-gl
marked markdown-it remark rehype unified mdast micromark sanitize-html dompurify isomorphic-dompurify xss
jsonwebtoken jose bcrypt bcryptjs argon2 crypto-js tweetnacl
pg postgres mysql mysql2 sqlite3 better-sqlite3 mongodb mongoose redis ioredis knex sequelize typeorm prisma @prisma/client drizzle-orm drizzle-kit kysely
socket.io socket.io-client graphql apollo-server @apollo/client urql
jest vitest mocha chai sinon ava tap playwright @playwright/test puppeteer cypress
eslint prettier stylelint husky lint-staged
semver resolve picomatch braces fill-range is-number kind-of ansi-regex strip-ansi supports-color has-flag
inherits once wrappy safe-buffer string_decoder readable-stream through2 event-stream
emoji-regex slugify validator he entities html-entities escape-html
sharp jimp canvas pdfkit qrcode jsqr
zustand redux @reduxjs/toolkit jotai recoil mobx valtio swr @tanstack/react-query
react-icons lucide-react @heroicons/react @radix-ui/react-dialog react-hook-form formik
howler tone canvas-confetti matter-js pixi.js phaser p5 kaboom
seedrandom random-words faker @faker-js/faker chance
isbot @react-router/node @react-router/serve @react-router/dev vite-tsconfig-paths @tailwindcss/vite`.split(/\s+/).filter(Boolean),
);
