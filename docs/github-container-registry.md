# Imagens para o Portainer

O workflow [publish-images.yml](../.github/workflows/publish-images.yml) publica
duas imagens OCI no GitHub Container Registry (GHCR) em cada `push` para a
branch `main`, em uma tag `v*` e quando for executado manualmente pela aba
**Actions** do GitHub.

| ServiÃ§o | Imagem |
| --- | --- |
| API e worker | `ghcr.io/joseojunior/lilibag-api` |
| Painel web | `ghcr.io/joseojunior/lilibag-web` |

Cada execuÃ§Ã£o acrescenta uma tag imutÃ¡vel no formato `sha-<commit-curto>`.
O Portainer deve receber exatamente essas tags. `latest` serve apenas para
consulta e nunca deve ser usada em produÃ§Ã£o.

Exemplo de variÃ¡veis da Stack depois da primeira publicaÃ§Ã£o:

```env
LILIBAG_API_IMAGE=ghcr.io/joseojunior/lilibag-api:sha-abc1234
LILIBAG_WEB_IMAGE=ghcr.io/joseojunior/lilibag-web:sha-abc1234
```

## Primeiro uso

1. FaÃ§a merge ou push deste workflow na `main`.
2. Abra **Actions â†’ Publish container images** e acompanhe os dois jobs.
3. Em GitHub, abra **Packages** e localize `lilibag-api` e `lilibag-web`.
4. Escolha a visibilidade dos pacotes:
   - **PÃºblico:** a VPS pode fazer pull sem login no GHCR.
   - **Privado:** crie um token de acesso pessoal (classic) com apenas
     `read:packages`, execute `docker login ghcr.io` no manager da VPS e
     informe o registry autenticado ao Portainer.
5. Copie as tags `sha-...` para `LILIBAG_API_IMAGE` e
   `LILIBAG_WEB_IMAGE` nas variÃ¡veis da Stack e faÃ§a o deploy.

O workflow usa o `GITHUB_TOKEN` temporÃ¡rio, com permissÃ£o `packages: write`;
nenhuma credencial de registry precisa ser criada ou salva nos secrets do
repositÃ³rio para publicar as imagens.
