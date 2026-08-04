export type AuthorClass = 'dependabot' | 'bot' | 'human'
export type AuthorFilter = 'all' | 'dependabot' | 'humans'

export function classifyAuthor(login: string | null, type: string | null): AuthorClass {
  if (!login) return 'bot'
  const lower = login.toLowerCase()
  if (lower.includes('dependabot')) return 'dependabot'
  if (type === 'Bot' || lower.includes('[bot]') || lower.startsWith('app/')) return 'bot'
  return 'human'
}

export function matchesAuthorFilter(authorClass: AuthorClass, filter: AuthorFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'humans') return authorClass === 'human'
  return authorClass === filter
}