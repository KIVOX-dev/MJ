import { RssFeed } from '../../research-assistant/web-search/rss';
import type { SectionFeed } from './news-digest.service';

const hindu = (_id: string, path: string) => new RssFeed('The Hindu', `https://www.thehindu.com/${path}/feeder/default.rss`);

/**
 * Real-time publisher feeds (free, no API credits, most carry a photo per story) that feed each digest section.
 * They are merged with the search APIs; the model then picks what is genuinely relevant to each section.
 */
export function sectionFeeds(): Record<string, SectionFeed[]> {
  const tn = hindu('tn', 'news/national/tamil-nadu');
  const india = hindu('india', 'news/national');
  const world = hindu('world', 'news/international');
  const sport = hindu('sport', 'sport');
  const movies = hindu('movies', 'entertainment/movies');
  const ndtv = new RssFeed('NDTV', 'https://feeds.feedburner.com/ndtvnews-india-news');
  const express = new RssFeed('The Indian Express', 'https://indianexpress.com/section/india/feed/');
  const bbcWorld = new RssFeed('BBC News', 'https://feeds.bbci.co.uk/news/world/rss.xml');
  const bbcSport = new RssFeed('BBC Sport', 'https://feeds.bbci.co.uk/sport/rss.xml');
  const variety = new RssFeed('Variety', 'https://variety.com/feed/');

  return {
    'Tamil Nadu - Politics': [tn],
    'Tamil Nadu - Sports': [tn, sport],
    'India - Politics': [india, ndtv, express],
    'India - Sports': [sport],
    'World - Politics': [world, bbcWorld],
    'World - Sports': [bbcSport],
    Kollywood: [movies],
    Hollywood: [variety],
    'Box Office and Trending Movies': [movies, variety],
    'Reviews and Public Response': [movies],
  };
}
