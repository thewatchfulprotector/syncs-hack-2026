This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `src/app/page.tsx`. The page auto-updates as you edit the file.

## Local persona ingestion

Keep source recordings under `media/<persona-id>/`; `media/` and generated `out/`
artifacts are intentionally excluded from Git.

Review every diarized speaker before indexing a podcast or interview. Missing
paid transcriptions require an explicit flag, and review mode never embeds,
writes to Pinecone, or creates audio clips:

```bash
npm run ingest -- --persona <persona-id> \
  --review-speakers --transcribe-missing \
  media/<persona-id>/*.mp3
```

The review is saved to `out/speaker-reviews/<persona-id>.json`. Identify the
persona separately in every file because labels such as `A` and `B` are local
to one transcript. Then index with a repeatable mapping:

```bash
npm run ingest -- --persona <persona-id> \
  --speaker-for 'first-podcast.mp3=A' \
  --speaker-for 'second-podcast.mp3=B' \
  media/<persona-id>/*.mp3
```

Multi-speaker sources without an explicit mapping fail rather than silently
choosing the longest speaker. `--auto-speaker` restores the old heuristic only
when deliberately requested. `--voice-sample` additionally creates one global,
timestamped sample across the approved speakers and should be used only when
the necessary voice rights and consent have been established.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
