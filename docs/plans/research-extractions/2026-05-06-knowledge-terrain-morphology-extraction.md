# Knowledge Terrain Morphology Research Extraction

Import set: `knowledge-terrain-morphology-2026-05-06`
Generated: 2026-05-06

## Thesis

Recall's current terrain map proves the visualization pipeline, but the surface is too close to a density heatmap. To make the map behave like a real knowledge landscape, the next feature should add morphology analysis: local peaks, basins, valleys, saddles, contour quality, and an over-smoothing or "one hill" warning.

The research supports this direction. Information-landscape work says map metaphors are useful only when cartographic method is taken seriously. Attributed-graph terrain research says graph topology and node attributes should both shape the terrain. Geomorphology and image segmentation research gives us practical language and algorithms for segmenting a continuous elevation surface into terrain units.

## Immediate Design Rules

1. Treat morphology as a diagnostic feature, not core Recall memory.
2. Separate density from landforms: a high-density blob is not automatically a meaningful mountain.
3. Detect multiple local maxima before trusting the map as a multi-region terrain.
4. Add a one-hill warning when the primary basin dominates the surface or peak count is too low.
5. Use watershed-style basin assignment to separate regions before visual interpretation.
6. Use topographic prominence ideas to distinguish meaningful peaks from noise.
7. Replace bounding-box contours with marching-squares or equivalent isolines in a later renderer slice.
8. Preserve the no-mutation contract: morphology reports must not change Recall memory, retrieval, ranking, promotion, or automation.

## Sources By Category

### cartographic-information-landscapes

- `skupin-2000-from-metaphor-to-method`: Spatial metaphors help users explore non-geographic information, but Skupin warns that information visualization often borrows map imagery without enough cartographic expertise. Map projection, generalization, labeling, scale, and map design should be treated as design constraints, not decoration.
  - Recall: Grounds the critique that the current map is too superficial. It needs scale, labeling, generalization, and contour/landform discipline.
  - Source: https://geog.sdsu.edu/People/Pages/skupin/research/pubs/InfoVis2000.pdf

- `skupin-2004-world-of-geography`: Knowledge domains can be visualized with cartographic means. The paper maps thousands of conference abstracts and reflects on plausibility.
  - Recall: Supports the idea that "knowledge terrain" is legitimate, but also implies the map must be validated against user/domain interpretation.
  - Source: https://pubmed.ncbi.nlm.nih.gov/14764896/

### attributed-graph-terrain

- `zhang-wang-parthasarathy-2017-terrain-metaphor`: Attributed graphs can be transformed into terrain maps that reveal graph topology plus numerical attributes, including dense subgraphs and k-cores.
  - Recall: Directly validates turning Recall's knowledge graph into a terrain surface. It also exposes the gap: our current surface emphasizes attributes/density more than topology and graph components.
  - Source: https://www.kdd.org/kdd2017/papers/view/visualizing-attributed-graphs-via-terrain-metaphor

### layout-and-positioning

- `mcinnes-healy-saul-grossberger-2018-umap`: UMAP provides scalable dimension reduction for visualization and can preserve local neighborhoods while retaining useful global structure.
  - Recall: Supports a later replacement for deterministic projection when anchors are missing. For the immediate morphology slice, do not introduce UMAP yet; first analyze the current grid and warn when layout is over-smoothed.
  - Source: https://joss.theoj.org/papers/10.21105/joss.00861

### contours-and-density

- `d3-contour-density`: D3 contour density implements fast two-dimensional kernel density estimation and generates density contours for point clouds.
  - Recall: Confirms that our current Gaussian surface is closer to KDE/density estimation than true morphology. Bandwidth controls matter because over-wide kernels merge distinct areas into one hill.
  - Source: https://d3js.org/d3-contour/density

- `d3-contour-marching-squares`: D3 contour creates contour polygons from rectangular numeric grids using marching squares.
  - Recall: The current renderer's bounding-box contour approximation should be replaced by true isolines or isobands.
  - Source: https://d3js.org/d3-contour

### terrain-morphology

- `kirmse-deferranti-2017-prominence-isolation`: Peak prominence and isolation can be computed from digital elevation models, identifying peaks and key saddles.
  - Recall: Gives the conceptual basis for deciding whether a peak is meaningful or just a small bump. We should add approximate local prominence now and improve it later.
  - Source: https://journals.sagepub.com/doi/abs/10.1177/0309133317738163

- `romstad-etzelmuller-2012-mean-curvature-watersheds`: Terrain segmentation subdivides a continuous elevation surface into meaningful terrain units; watershed-style methods can identify hills/depressions and boundaries.
  - Recall: Supports basin segmentation as the next step from "one hill" heatmap to distinct knowledge landforms.
  - Source: https://www.sciencedirect.com/science/article/pii/S0169555X11005575

- `watershed-transform-reference`: The watershed transform treats a grayscale image as a topographic surface and labels catchment basins or watershed ridge lines.
  - Recall: Practical model for assigning grid cells to basins and producing separable regions.
  - Source: https://www.mathworks.com/help/images/ref/watershed.html

## Build Recommendation

Build `terrain-morphology` as the next feature-layer report.

Minimum report:

- local peaks from the elevation grid
- local valleys/minima
- watershed-like basin assignment by steepest ascent
- basin dominance ratio
- approximate peak prominence
- one-hill score and warning
- morphology status:
  - `morphology_distinct`
  - `morphology_weak`
  - `one_hill_over_smoothed`

Do not mutate active terrain. Do not change Recall memory. Do not change retrieval, ranking, promotion, or automation.

## Deferred Follow-Up

After morphology diagnostics exist:

1. Add true marching-squares contours.
2. Add peak/basin labels to the HTML renderer.
3. Add adaptive bandwidth controls.
4. Add optional UMAP layout adapter behind a diagnostic-only flag.
5. Add user review/anchor workflow for naming peaks and basins.
