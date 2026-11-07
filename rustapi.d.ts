export interface ItemRef {
  id?: string;
  slug?: string;
  name?: string;
  path?: string;
  resolved?: boolean;
}

export interface CostEntry {
  item: ItemRef;
  amount: number;
}

export interface ItemSummary {
  slug: string;
  name: string;
  category?: string;
  categories?: string[];
  iconUrl?: string;
  id: string;
  shortName: string;
  ingameId: number;
  stackSize?: number;
  maxCondition?: number;
  despawnSeconds?: number;
  craftable?: boolean;
  recyclable?: boolean;
  deployable?: boolean;
  consumable?: boolean;
  techTreeIndex?: number;
  hasSkins?: boolean;
  path: string;
}

export interface RaidAttack {
  item: ItemRef;
  damagePerItem: number;
  requiredItems: number;
  crafts?: number;
  craftCost: CostEntry[];
  totalCost?: CostEntry[];
  derived?: Record<string, boolean>;
}

export interface ItemDetail extends ItemSummary {
  description?: string;
  seoDescription?: string;
  craft?: Record<string, unknown> | null;
  recycle?: Array<Record<string, unknown>>;
  recycledFrom?: Array<Record<string, unknown>>;
  usedInCrafting?: Array<Record<string, unknown>>;
  lootContainers?: Array<Record<string, unknown>>;
  obtainedFrom?: Array<Record<string, unknown>>;
  consumption?: Record<string, unknown>;
  deployableInfo?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  raid?: { explosive?: RaidAttack[] } & Record<string, unknown>;
  repair?: Array<Record<string, unknown>>;
  vendor?: Array<Record<string, unknown>>;
  relatedItems?: ItemRef[];
  flags?: string[];
  sections?: unknown;
  tabs?: unknown;
  introduction?: Record<string, unknown>;
  links?: Record<string, ItemRef[]>;
  extras?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  pages: number;
  next: number | null;
  prev: number | null;
}

export interface ItemsQuery {
  q?: string;
  category?: string;
  craftable?: boolean;
  recyclable?: boolean;
  deployable?: boolean;
  hasSkins?: boolean;
  minStackSize?: number;
  maxStackSize?: number;
  sort?: 'name' | 'slug' | 'category' | 'stackSize';
  order?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
  fields?: string[];
}

export interface SearchOptions {
  types?: Array<'item' | 'skin' | 'monument' | 'building' | 'world' | 'update' | 'command'>;
  limit?: number;
  fuzzy?: boolean;
}

export interface SearchHit {
  type: string;
  slug: string;
  name: string;
  category: string | null;
  path: string;
  score: number;
}

export interface RaidOptions {
  damageType?: 'explosive' | 'bullet' | 'melee';
  grade?: string;
  sort?: 'name' | 'health' | 'requiredItems';
  order?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
}

export interface RaidBlock {
  slug: string;
  name: string;
  grade?: string;
  category?: string;
  health?: number;
  path: string;
  attacks: RaidAttack[];
}

export interface CommandOptions {
  q?: string;
  category?: string;
  adminOnly?: boolean;
  removed?: boolean;
  server?: boolean;
  client?: boolean;
  page?: number;
  perPage?: number;
}

export interface Command {
  fullName: string;
  name: string;
  category: string;
  adminOnly?: boolean;
  server?: boolean;
  client?: boolean;
  removed?: boolean;
}

export interface Skin {
  slug: string;
  name: string;
  itemDisplayName?: string;
  itemSlug?: string | null;
  iconUrl?: string;
  price?: number;
  priceFormatted?: string;
  marketable?: boolean;
  isActiveStoreItem?: boolean;
}

export interface Category {
  name: string;
  slug: string;
  count: number;
  path: string;
}

export declare class RustApiError extends Error {
  status: number;
  problem: unknown;
}

export declare class RustApi {
  constructor(options?: { staticBase?: string; dynamicBase?: string; fetchImpl?: typeof fetch });
  meta(): Promise<Record<string, unknown>>;
  getPath(path: string): Promise<unknown>;
  item(slug: string): Promise<ItemDetail>;
  itemRaw(slug: string): Promise<unknown>;
  itemsIndex(): Promise<ItemSummary[]>;
  categories(): Promise<Category[]>;
  building(slug: string): Promise<Record<string, unknown>>;
  monument(slug: string): Promise<Record<string, unknown>>;
  world(slug: string): Promise<Record<string, unknown>>;
  skinsForItem(slug: string): Promise<Skin[]>;
  updates(): Promise<Array<Record<string, unknown>>>;
  items(
    options: ItemsQuery & { fields: string[] },
  ): Promise<{ items: Array<Partial<ItemSummary>>; pagination: Pagination; source: string }>;
  items(options?: ItemsQuery): Promise<{ items: ItemSummary[]; pagination: Pagination; source: string }>;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  raidCosts(options?: RaidOptions): Promise<{ blocks: RaidBlock[]; pagination: Pagination; source: string }>;
  commands(options?: CommandOptions): Promise<{ commands: Command[]; pagination: Pagination; source: string }>;
}
