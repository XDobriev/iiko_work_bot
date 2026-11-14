import { normalizeName } from '../db/invoices.repo.js';

export interface CatalogProduct {
  id: string;
  name: string;
  unit?: string;
  type?: string;
  isDeleted?: boolean;
}

export interface ProductMappingStore {
  findProductMapping(rawName: string): { iikoProductName: string; iikoProductId?: string } | null;
  saveProductMapping(rawName: string, iikoProductName: string, iikoProductId?: string): void;
}

export type MatchSource = 'mapping' | 'exact' | 'tokens' | 'fuzzy';
export type UnitCategory = 'weight' | 'volume' | 'piece' | 'unknown';

export interface ProductMatch {
  product: CatalogProduct;
  score: number;
  source: MatchSource;
  unitMismatch: boolean;
  unitWarning?: string;
}

export function normalizeIikoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\|[^|]*\|/g, ' ')
    .replace(/[*«»"'()[\],.:;!?-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeName(name: string): string[] {
  const norm = normalizeIikoName(name);
  return norm
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], prev, row[j]) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

export function getUnitCategory(unit?: string): UnitCategory {
  if (!unit) return 'unknown';
  const u = unit.toLowerCase().replace(/[^a-zа-яё]/gi, '').trim();
  if (!u) return 'unknown';

  if (['кг', 'г', 'гр', 'килограмм', 'килограмма', 'килограммов', 'грамм', 'грамма', 'граммов', 'kg', 'g'].includes(u) || u.startsWith('килограмм') || u.startsWith('грамм')) {
    return 'weight';
  }
  if (['л', 'мл', 'литр', 'литра', 'литров', 'миллилитр', 'миллилитра', 'миллилитров', 'l', 'ml'].includes(u) || u.startsWith('литр') || u.startsWith('миллилитр')) {
    return 'volume';
  }
  if (['шт', 'бан', 'банка', 'бут', 'бутылка', 'уп', 'упаковка', 'пач', 'пачка', 'ящ', 'ящик', 'короб', 'порц', 'порция', 'рулон'].some(x => u.startsWith(x))) {
    return 'piece';
  }
  return 'unknown';
}

export function checkUnitMismatch(rawUnit?: string, catalogUnit?: string): { mismatch: boolean; warning?: string } {
  if (!rawUnit || !catalogUnit) {
    return { mismatch: false };
  }
  const catRaw = getUnitCategory(rawUnit);
  const catCatalog = getUnitCategory(catalogUnit);

  if (catRaw !== 'unknown' && catCatalog !== 'unknown' && catRaw !== catCatalog) {
    return {
      mismatch: true,
      warning: `Внимание: расхождение единиц! В накладной: «${rawUnit}», в номенклатуре iiko: «${catalogUnit}».`
    };
  }
  return { mismatch: false };
}

export class ProductCatalogMatcher {
  private products: CatalogProduct[];
  private mappingStore?: ProductMappingStore;

  constructor(products: CatalogProduct[], mappingStore?: ProductMappingStore) {
    this.products = products.filter(p => !p.isDeleted);
    this.mappingStore = mappingStore;
  }

  match(rawName: string, rawUnit?: string): ProductMatch | null {
    if (!rawName || !rawName.trim()) {
      return null;
    }

    const trimmed = rawName.trim();
    const normQuery = normalizeIikoName(trimmed);
    if (!normQuery) {
      return null;
    }

    // 1. Check explicit mapping in store
    if (this.mappingStore) {
      const mapping = this.mappingStore.findProductMapping(trimmed) || this.mappingStore.findProductMapping(normQuery);
      if (mapping) {
        const found = this.products.find(p => (mapping.iikoProductId && p.id === mapping.iikoProductId) || normalizeIikoName(p.name) === normalizeIikoName(mapping.iikoProductName));
        if (found) {
          const unitCheck = checkUnitMismatch(rawUnit, found.unit);
          return {
            product: found,
            score: 1.0,
            source: 'mapping',
            unitMismatch: unitCheck.mismatch,
            unitWarning: unitCheck.warning
          };
        }
      }
    }

    // 2. Exact normalized match
    const exactMatch = this.products.find(p => normalizeIikoName(p.name) === normQuery);
    if (exactMatch) {
      const unitCheck = checkUnitMismatch(rawUnit, exactMatch.unit);
      return {
        product: exactMatch,
        score: 1.0,
        source: 'exact',
        unitMismatch: unitCheck.mismatch,
        unitWarning: unitCheck.warning
      };
    }

    // 3. Token-based and similarity scoring
    const queryTokens = tokenizeName(trimmed);
    if (queryTokens.length === 0) {
      return null;
    }

    let bestMatch: CatalogProduct | null = null;
    let bestScore = 0;
    let bestSource: MatchSource = 'tokens';

    for (const cand of this.products) {
      const candNorm = normalizeIikoName(cand.name);
      const candTokens = tokenizeName(cand.name);
      if (candTokens.length === 0) continue;

      let matchedWeight = 0;
      let matchedCount = 0;

      for (const qToken of queryTokens) {
        let bestTokenScore = 0;

        for (const cToken of candTokens) {
          if (qToken === cToken) {
            bestTokenScore = Math.max(bestTokenScore, 1.0);
            break;
          }

          // Prefix matching (e.g. томат / томаты, requiring at least 3 chars for prefixes)
          const minLen = Math.min(qToken.length, cToken.length);
          const isNumeric = /^\d+$/.test(qToken) || /^\d+$/.test(cToken);
          if (!isNumeric && minLen >= 3 && (qToken.startsWith(cToken) || cToken.startsWith(qToken)) && Math.abs(qToken.length - cToken.length) <= 3) {
            bestTokenScore = Math.max(bestTokenScore, 0.9);
            continue;
          }

          // Typo / Levenshtein
          if (qToken.length >= 4 && cToken.length >= 4) {
            const dist = levenshteinDistance(qToken, cToken);
            if (dist === 1) {
              bestTokenScore = Math.max(bestTokenScore, 0.9);
            } else if (dist === 2 && (qToken.length >= 5 || cToken.length >= 5)) {
              bestTokenScore = Math.max(bestTokenScore, 0.75);
            }
          }
        }

        if (bestTokenScore > 0) {
          matchedWeight += bestTokenScore;
          matchedCount++;
        }
      }

      const coverage = matchedWeight / queryTokens.length;
      if (coverage < 0.5) {
        continue;
      }

      const jaccard = matchedWeight / (candTokens.length + queryTokens.length - matchedWeight);
      let score = (coverage * 0.65) + (jaccard * 0.35);

      // Substring bonus if exact phrase is contained
      if (candNorm.includes(normQuery)) {
        score += 0.05;
      }

      // Bonus if first word (head noun) matched well
      if (candTokens.length > 0 && queryTokens.length > 0) {
        const headDist = levenshteinDistance(queryTokens[0], candTokens[0]);
        if (headDist <= 1 || (headDist <= 2 && queryTokens[0].length >= 5)) {
          score += 0.08;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = cand;
        bestSource = matchedCount === queryTokens.length && matchedWeight === queryTokens.length ? 'tokens' : 'fuzzy';
      } else if (Math.abs(score - bestScore) < 0.001 && bestMatch) {
        // Tie-breaker: choose candidate whose token count is closer to query token count
        const currentDiff = Math.abs(tokenizeName(bestMatch.name).length - queryTokens.length);
        const newDiff = Math.abs(candTokens.length - queryTokens.length);
        if (newDiff < currentDiff) {
          bestMatch = cand;
        }
      }
    }

    // Minimum acceptance threshold: 0.60
    if (bestMatch && bestScore >= 0.60) {
      const unitCheck = checkUnitMismatch(rawUnit, bestMatch.unit);
      return {
        product: bestMatch,
        score: Math.round(bestScore * 100) / 100,
        source: bestSource,
        unitMismatch: unitCheck.mismatch,
        unitWarning: unitCheck.warning
      };
    }

    return null;
  }

  saveMapping(rawName: string, product: CatalogProduct): void {
    if (this.mappingStore) {
      this.mappingStore.saveProductMapping(rawName, product.name, product.id);
    }
  }
}
