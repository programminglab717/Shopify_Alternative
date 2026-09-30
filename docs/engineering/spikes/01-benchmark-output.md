# Spike 1 · Benchmark output

Node v22.22.2, Intel(R) Xeon(R) Processor @ 2.10GHz (4 cores), one process. Hatti Base (24 files), the sample shop (201 products). 500 renders a page after 50 to warm up.

## A. Rendering alone (data in memory)

| Page | p50 ms | p95 ms | p99 ms | max ms | CPU ms | Output KB | Nodes | Round trips |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Home | 3.5 | 5.4 | 6.8 | 10.5 | 4.7 | 18 | 1204 | 9 |
| Home, Urdu | 3.3 | 4.4 | 5.3 | 8.8 | 4.0 | 18 | 1204 | 9 |
| Product (lawn suit, 6 variants) | 2.1 | 2.9 | 4.3 | 6.5 | 2.6 | 20 | 775 | 6 |
| Product (100 variants, 10 images) | 5.8 | 6.8 | 8.0 | 15.6 | 6.3 | 95 | 2587 | 6 |
| Collection, 24 a page | 3.8 | 4.7 | 6.0 | 9.9 | 4.2 | 22 | 1583 | 6 |

## B. With 1 ms a round trip: sections side by side or in turn, products by the chunk or one by one

| Page | Side by side p50 | p95 | In turn p50 | p95 | One by one p50 | p95 | Round trips one by one |
|---|---:|---:|---:|---:|---:|---:|---:|
| Home | 6.6 | 8.5 | 11.6 | 13.5 | 14.0 | 15.9 | 22 |
| Home, Urdu | 6.4 | 7.5 | 11.5 | 13.1 | 13.9 | 16.1 | 22 |
| Product (lawn suit, 6 variants) | 4.5 | 5.8 | 5.5 | 6.3 | 8.0 | 9.2 | 9 |
| Product (100 variants, 10 images) | 8.3 | 9.5 | 9.2 | 11.4 | 12.2 | 13.9 | 9 |
| Collection, 24 a page | 7.1 | 8.1 | 7.3 | 8.7 | 33.8 | 35.9 | 28 |

## C. First render of a theme version (parsing included)

| Page | Median of 20 ms | Parse the whole theme ms |
|---|---:|---:|
| Home | 5.6 | 2.1 |
| Home, Urdu | 4.8 | 1.8 |
| Product (lawn suit, 6 variants) | 4.0 | 1.8 |
| Product (100 variants, 10 images) | 8.4 | 1.7 |
| Collection, 24 a page | 5.5 | 1.8 |

## D. Under load: requests at a time for 5 s, 1 ms a round trip, pages mixed

| At a time | Pages a second | p50 ms | p95 ms | p99 ms | CPU busy |
|---:|---:|---:|---:|---:|---:|
| 8 | 256 | 30.1 | 40.7 | 55.1 | 110% |
| 64 | 266 | 238.1 | 259.0 | 267.5 | 116% |

## E. Sections that go over a limit (the rest of the page still renders)

| Section | Stopped by | After ms | Nodes rendered | Page ms |
|---|---|---:|---:|---:|
| Loop of 400 × 400 | nodes | 42.2 | 50001 | 43.7 |
| Endless recursion | depth | 1.4 | 66 | 2.6 |
| 10 MB of output | output | 85.6 | 31433 | 86.7 |
| Range of 10 million | memory | 0.4 | 2 | 1.5 |
| Slow loop, few nodes | nodes | 126.9 | 50001 | 127.7 |
