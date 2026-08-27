/**
 * ECR tests for the private AWS Nuke image.
 *
 * Only runs when `ISB_PRIVATE_ECR_REPO` is set. The pipeline sets this when
 * `BUILD_AND_PUSH_NUKE_IMAGE=true`. Otherwise the upstream uses the public
 * AWS-published image and there is nothing to verify here.
 *
 * Asserts:
 *   1. The repo exists.
 *   2. There is at least one image in the repo.
 *   3. The most recent image has a digest (i.e. push completed).
 */
import {
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  ECRClient,
} from '@aws-sdk/client-ecr';

import { loadIntegrationEnv } from './support/test-env';

jest.setTimeout(120_000);

const env = loadIntegrationEnv();

const repoName = process.env.ISB_PRIVATE_ECR_REPO;

const describeOrSkip = repoName ? describe : describe.skip;

describeOrSkip('ECR (private nuke image)', () => {
  const client = new ECRClient({ region: env.hubRegion });

  it('the configured repository exists', async () => {
    const response = await client.send(
      new DescribeRepositoriesCommand({ repositoryNames: [repoName!] }),
    );
    expect(response.repositories?.length).toBe(1);
  });

  it('repository has at least one image', async () => {
    const response = await client.send(
      new DescribeImagesCommand({ repositoryName: repoName! }),
    );
    const images = response.imageDetails ?? [];
    expect(images.length).toBeGreaterThan(0);
  });

  it('latest image has a sha256 digest', async () => {
    const response = await client.send(
      new DescribeImagesCommand({ repositoryName: repoName! }),
    );
    const images = (response.imageDetails ?? []).sort(
      (a, b) =>
        (b.imagePushedAt?.getTime() ?? 0) - (a.imagePushedAt?.getTime() ?? 0),
    );
    expect(images[0]?.imageDigest).toMatch(/^sha256:/);
  });
});
