import { describe, expect, it } from 'vitest'
import { classifyAuthor, matchesAuthorFilter } from './authors'

describe('classifyAuthor', () => {
  it('recognises dependabot in its several login forms', () => {
    expect(classifyAuthor('dependabot', 'Bot')).toBe('dependabot')
    expect(classifyAuthor('dependabot[bot]', 'Bot')).toBe('dependabot')
    expect(classifyAuthor('app/dependabot', 'Bot')).toBe('dependabot')
    expect(classifyAuthor('DEPENDABOT[BOT]', 'Bot')).toBe('dependabot')
  })

  it('classifies other bots as bot, not dependabot', () => {
    expect(classifyAuthor('renovate[bot]', 'Bot')).toBe('bot')
    expect(classifyAuthor('github-actions[bot]', 'Bot')).toBe('bot')
  })

  it('classifies real users as human', () => {
    expect(classifyAuthor('slachiewicz', 'User')).toBe('human')
  })

  it('does not treat a user merely named like a bot as a bot', () => {
    expect(classifyAuthor('robotics-fan', 'User')).toBe('human')
  })

  it('falls back to human when the type is missing', () => {
    expect(classifyAuthor('someone', null)).toBe('human')
  })

  it('classifies a missing login as bot rather than inventing a human', () => {
    expect(classifyAuthor(null, null)).toBe('bot')
  })
})

describe('matchesAuthorFilter', () => {
  it('passes everything under all', () => {
    expect(matchesAuthorFilter('dependabot', 'all')).toBe(true)
    expect(matchesAuthorFilter('bot', 'all')).toBe(true)
    expect(matchesAuthorFilter('human', 'all')).toBe(true)
  })

  it('passes only dependabot under dependabot', () => {
    expect(matchesAuthorFilter('dependabot', 'dependabot')).toBe(true)
    expect(matchesAuthorFilter('bot', 'dependabot')).toBe(false)
    expect(matchesAuthorFilter('human', 'dependabot')).toBe(false)
  })

  it('passes only humans under humans, excluding all bots', () => {
    expect(matchesAuthorFilter('human', 'humans')).toBe(true)
    expect(matchesAuthorFilter('bot', 'humans')).toBe(false)
    expect(matchesAuthorFilter('dependabot', 'humans')).toBe(false)
  })
})