import { loadFeatures, runFeatures } from "@questi0nm4rk/feats";
import "./run-pipeline.steps.js";

const features = await loadFeatures("tests/features/run-pipeline.feature");
runFeatures(features, {
  worldFactory: () => ({ modules: [] }),
});
