import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShopDomain,
  MAX_PRODUCTS,
  runShopifyOperation,
  shapeProductSearchData,
  shapeCatalogProductSearchData,
  buildVolatileMapFromNodes,
  mergeVolatilePricingIntoProducts,
  normalizeProductCategory,
  buildProductSearchShopifyQuery,
  productMatchesCategoryHeuristic,
  buildInventoryDisplayForProduct,
} from './index.js';

test('normalizeShopDomain strips protocol and path', () => {
  assert.equal(normalizeShopDomain('https://foo.myshopify.com/admin'), 'foo.myshopify.com');
  assert.equal(normalizeShopDomain('bar.myshopify.com'), 'bar.myshopify.com');
});

test('MAX_PRODUCTS is within sane bounds', () => {
  assert.ok(MAX_PRODUCTS >= 1 && MAX_PRODUCTS <= 50);
});

test('runShopifyOperation rejects unknown operation', async () => {
  const out = await runShopifyOperation('delete_everything', {}, '00000000-0000-4000-8000-000000000001');
  assert.equal(out.ok, false);
  assert.ok(Array.isArray(out.data?.allowed));
});

test('product_search fails closed without query', async () => {
  const out = await runShopifyOperation('product_search', {}, '00000000-0000-4000-8000-000000000002');
  assert.equal(out.ok, false);
  assert.equal(out.data?.error_code, 'missing_query');
});

test('buildInventoryDisplayForProduct rolls up locations and colours', () => {
  const product = {
    title: 'Fatfish OG',
    variants: [
      {
        title: 'Fatfish OG — Army Green',
        colour: 'Army Green',
        options: [{ name: 'Colour', value: 'Army Green' }],
        sku: 'FF-ARMY',
        inventory_by_location: [{ location_name: 'Brisbane', available: 2 }],
      },
      {
        title: 'Fatfish OG — White',
        colour: 'White',
        options: [{ name: 'Colour', value: 'White' }],
        sku: 'FF-WHT',
        inventory_by_location: [{ location_name: 'Burleigh', available: 1 }],
      },
    ],
  };
  const d = buildInventoryDisplayForProduct(product);
  assert.equal(d.lines.length, 2);
  assert.match(d.summary, /2x Brisbane · Army Green/i);
  assert.match(d.summary, /1x Burleigh · White/i);
});

test('normalizeProductCategory maps scooter and part aliases', () => {
  assert.equal(normalizeProductCategory('e-bike'), 'ebike');
  assert.equal(normalizeProductCategory('parts'), 'part');
  assert.equal(normalizeProductCategory('scooters'), 'scooter');
  assert.equal(normalizeProductCategory('all'), 'all');
});

test('buildProductSearchShopifyQuery ANDs search with env category fragment', () => {
  process.env.SHOPIFY_SEARCH_FILTER_EBIKE = 'product_type:"Electric Bike"';
  const out = buildProductSearchShopifyQuery({ search: 'Fatfish OG', category: 'ebike' });
  assert.match(out.q, /Fatfish OG/);
  assert.match(out.q, /product_type/);
  assert.equal(out.category, 'ebike');
  assert.equal(out.category_filter_applied, true);
  delete process.env.SHOPIFY_SEARCH_FILTER_EBIKE;
});

test('buildProductSearchShopifyQuery uses payload.category_query override', () => {
  const out = buildProductSearchShopifyQuery({
    search: 'OG',
    category: 'ebike',
    category_query: 'product_type:Spare',
  });
  assert.match(out.q, /OG/);
  assert.match(out.q, /Spare/);
  assert.equal(out.category_filter_applied, true);
});

test('buildProductSearchShopifyQuery notes missing env filter', () => {
  const out = buildProductSearchShopifyQuery({ query: 'bolt', category: 'part' });
  assert.equal(out.category, 'part');
  assert.equal(out.category_filter_applied, false);
  assert.match(out.category_filter_note || '', /SHOPIFY_SEARCH_FILTER/);
});

test('productMatchesCategoryHeuristic excludes parts when category is ebike', () => {
  const bike = {
    title: 'Fatfish OG Fat Tyre E-Bike',
    product_type: 'FATFISH BIKES (OG)',
    tags: ['Ride Electric'],
  };
  const part = {
    title: 'Fatfish OG Disc Rotor',
    product_type: 'FATFISH PARTS (OG)',
    tags: ['Fatfish Parts'],
  };
  assert.equal(productMatchesCategoryHeuristic(bike, 'ebike'), true);
  assert.equal(productMatchesCategoryHeuristic(part, 'ebike'), false);
});

test('catalog shape merges volatile price and availability', () => {
  const catalog = shapeCatalogProductSearchData({
    shop: { currencyCode: 'AUD' },
    products: {
      edges: [
        {
          node: {
            id: 'gid://shopify/Product/1',
            title: 'Test',
            handle: 'test',
            status: 'ACTIVE',
            vendor: '',
            productType: '',
            tags: [],
            featuredImage: null,
            variants: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/ProductVariant/9',
                    title: 'Default',
                    displayName: 'Test — Default',
                    sku: 'SKU1',
                    barcode: '',
                    selectedOptions: [{ name: 'Colour', value: 'Red' }],
                  },
                },
              ],
            },
          },
        },
      ],
    },
  });
  assert.equal(catalog.products[0].variants[0].price, null);
  assert.equal(catalog.products[0].variants[0].available_for_sale, null);
  const volMap = buildVolatileMapFromNodes(
    [
      {
        id: 'gid://shopify/ProductVariant/9',
        price: '12.50',
        compareAtPrice: null,
        availableForSale: true,
        inventoryQuantity: 7,
        inventoryItem: {
          id: 'gid://shopify/InventoryItem/1',
          tracked: true,
          inventoryLevels: {
            edges: [
              {
                node: {
                  id: 'gid://shopify/InventoryLevel/10',
                  quantities: [{ name: 'available', quantity: 4 }],
                  location: { id: 'gid://shopify/Location/2', name: 'Sydney DC' },
                },
              },
              {
                node: {
                  id: 'gid://shopify/InventoryLevel/11',
                  quantities: [{ name: 'available', quantity: 3 }],
                  location: { id: 'gid://shopify/Location/3', name: 'Melbourne Store' },
                },
              },
            ],
          },
        },
      },
    ],
    'AUD',
  );
  mergeVolatilePricingIntoProducts(catalog.products, volMap);
  assert.equal(catalog.products[0].variants[0].price.amount, '12.50');
  assert.equal(catalog.products[0].variants[0].price.currency_code, 'AUD');
  assert.equal(catalog.products[0].variants[0].available_for_sale, true);
  assert.equal(catalog.products[0].variants[0].inventory_quantity, 7);
  const locs = catalog.products[0].variants[0].inventory_by_location;
  assert.equal(locs.length, 2);
  assert.equal(locs[0].location_name, 'Sydney DC');
  assert.equal(locs[0].available, 4);
  assert.equal(locs[1].location_name, 'Melbourne Store');
  assert.equal(locs[1].available, 3);
});

test('shapeProductSearchData maps scalar Money price with shop currency', () => {
  const shaped = shapeProductSearchData({
    shop: { currencyCode: 'AUD' },
    products: {
      edges: [
        {
          node: {
            id: 'gid://shopify/Product/2',
            title: 'Test',
            handle: 'test',
            status: 'ACTIVE',
            vendor: '',
            productType: '',
            tags: [],
            featuredImage: null,
            variants: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/ProductVariant/1',
                    title: 'Default',
                    displayName: 'Test',
                    sku: '',
                    barcode: '',
                    availableForSale: true,
                    inventoryQuantity: null,
                    price: '99.50',
                    compareAtPrice: null,
                    selectedOptions: [],
                  },
                },
              ],
            },
          },
        },
      ],
    },
  });
  assert.equal(shaped.products[0].variants[0].price.amount, '99.50');
  assert.equal(shaped.products[0].variants[0].price.currency_code, 'AUD');
});

test('shapeProductSearchData maps variants price options and colour', () => {
  const shaped = shapeProductSearchData({
    products: {
      edges: [
        {
          node: {
            id: 'gid://shopify/Product/1',
            title: 'Fatfish OG',
            handle: 'fatfish-og',
            status: 'ACTIVE',
            vendor: 'Fatfish',
            productType: 'E-Bike',
            tags: ['electric'],
            featuredImage: null,
            variants: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/ProductVariant/9',
                    title: 'Red',
                    displayName: 'Fatfish OG — Red',
                    sku: 'FF-OG-R',
                    barcode: '',
                    availableForSale: true,
                    inventoryQuantity: 3,
                    price: { amount: '2499.00', currencyCode: 'AUD' },
                    compareAtPrice: null,
                    selectedOptions: [
                      { name: 'Colour', value: 'Red' },
                      { name: 'Size', value: 'Large' },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    },
  });
  assert.equal(shaped.count, 1);
  assert.equal(shaped.products[0].storefront_path, '/products/fatfish-og');
  assert.equal(shaped.products[0].variants.length, 1);
  assert.equal(shaped.products[0].variants[0].colour, 'Red');
  assert.equal(shaped.products[0].variants[0].price.amount, '2499.00');
  assert.equal(shaped.products[0].variants[0].inventory_quantity, 3);
});
