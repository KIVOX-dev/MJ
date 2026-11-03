import { z } from 'zod';
import type { ToolRegistry } from '../../../core/tool-registry';
import { regionQuery, type NewsSource } from './newsdata.client';

export function registerNewsTools(registry: ToolRegistry, news: NewsSource): void {
  registry.register({
    name: 'get_news',
    description:
      'Fetch the latest news articles (roughly the last 48 hours) for a region and optional category/topic. ' +
      'Summarise ONLY what the returned articles say, mention the source name, and never add facts that are not in them. ' +
      'If nothing relevant is returned, say so.',
    schema: z.object({
      region: z.enum(['tamil_nadu', 'india', 'world']).describe('Geographic focus'),
      category: z
        .enum(['politics', 'sports', 'business', 'technology', 'science', 'health', 'entertainment', 'world'])
        .optional()
        .describe('News category'),
      topic: z.string().max(100).optional().describe('Optional keyword, in English'),
    }),
    async run(args) {
      const articles = await news.search(regionQuery(args.region, args.category, args.topic));
      return {
        count: articles.length,
        articles: articles.slice(0, 6).map((a) => ({
          title: a.title,
          summary: a.description,
          source: a.source,
          published: a.pubDate,
          link: a.link,
        })),
      };
    },
  });
}
