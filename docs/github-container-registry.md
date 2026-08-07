# Images for Portainer

The [publish-images.yml](../.github/workflows/publish-images.yml) workflow
publishes two OCI images to GitHub Container Registry (GHCR) on every push to
`main`, on `v*` tags, and when started manually from the GitHub Actions tab.

| Service | Image |
| --- | --- |
| API and worker | `ghcr.io/joseojunior/lilibag-api` |
| Web panel | `ghcr.io/joseojunior/lilibag-web` |

Every run creates an immutable `sha-<short-commit>` tag. Configure Portainer
with those tags; do not use `latest` in production.

```env
LILIBAG_API_IMAGE=ghcr.io/joseojunior/lilibag-api:sha-abc1234
LILIBAG_WEB_IMAGE=ghcr.io/joseojunior/lilibag-web:sha-abc1234
```

## First use

1. Push the workflow to `main` and wait for both Actions jobs to succeed.
2. Open **Packages** in GitHub and find `lilibag-api` and `lilibag-web`.
3. Choose package visibility:
   - **Public:** the VPS can pull images anonymously.
   - **Private:** create a classic personal access token with only
     `read:packages`, run `docker login ghcr.io` on the Swarm manager, and
     configure the authenticated registry in Portainer.
4. Copy the `sha-...` tags to `LILIBAG_API_IMAGE` and `LILIBAG_WEB_IMAGE` in
   the Stack variables and deploy.

The workflow uses the temporary `GITHUB_TOKEN` with `packages: write`.
No registry credential is stored in the repository to publish the images.
