<script lang="ts">
  import AlbumSharedLink from '$lib/components/album-page/album-shared-link.svelte';
  import HeaderActionButton from '$lib/components/HeaderActionButton.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import UserAvatar from '$lib/components/shared-components/user-avatar.svelte';
  import { AlbumPageViewMode } from '$lib/constants';
  import {
    getAlbumActions,
    handleRefreshAlbumsForSharedUsers,
    handleRemoveUserFromAlbum,
    handleUpdateAlbum,
    handleUpdateUserAlbumRole,
  } from '$lib/services/album.service';
  import {
    AlbumUserRole,
    AssetOrder,
    getAlbumInfo,
    getAllSharedLinks,
    type AlbumResponseDto,
    type SharedLinkResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import {
    Button,
    Field,
    HStack,
    LoadingSpinner,
    Modal,
    ModalBody,
    Select,
    Stack,
    Switch,
    Text,
    type SelectOption,
  } from '@immich/ui';
  import { mdiSync } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  type Props = {
    album: AlbumResponseDto;
    onClose: () => void;
  };

  let { album, onClose }: Props = $props();

  // Simple spinner state
  let isLoading = $state(false);
  let isReSharingLoading = $state(false);

  const handleRoleSelect = async (user: UserResponseDto, role: AlbumUserRole | 'none') => {
    try {
      if (role === 'none') {
        await handleRemoveUserFromAlbum(album, user, async () => {
          isLoading = true; // Show spinner
        });
        return;
      }

      await handleUpdateUserAlbumRole({ albumId: album.id, userId: user.id, role });
    } finally {
      isLoading = false; // Hide spinner
    }
  };

  const handleRefreshAlbumsForSharedUsersClick = async (album: AlbumResponseDto) => {
    try {
      isReSharingLoading = true;
      await handleRefreshAlbumsForSharedUsers(album);
    } finally {
      isReSharingLoading = false; // Hide spinner
    }
  };

  const refreshAlbum = async () => {
    album = await getAlbumInfo({ id: album.id, withoutAssets: true });
  };

  const onAlbumUserDelete = async ({ userId }: { userId: string }) => {
    album.albumUsers = album.albumUsers.filter(({ user: { id } }) => id !== userId);
    await refreshAlbum();
  };

  const onSharedLinkCreate = (sharedLink: SharedLinkResponseDto) => {
    sharedLinks.push(sharedLink);
  };

  const onSharedLinkDelete = (sharedLink: SharedLinkResponseDto) => {
    sharedLinks = sharedLinks.filter(({ id }) => sharedLink.id !== id);
  };

  const { AddUsers, CreateSharedLink } = $derived(getAlbumActions($t, album, AlbumPageViewMode.OPTIONS));

  let sharedLinks: SharedLinkResponseDto[] = $state([]);

  onMount(async () => {
    sharedLinks = await getAllSharedLinks({ albumId: album.id });
  });
</script>

<!-- Full-screen spinner overlay -->
{#if isLoading}
  <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 pointer-events-auto">
    <div class="bg-white p-6 rounded-lg shadow-lg flex items-center gap-3">
      <LoadingSpinner size="giant" />
      <Text size="large">{$t('remove_shared_album_user_spinner_text')}</Text>
    </div>
  </div>
{/if}

{#if isReSharingLoading}
  <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 pointer-events-auto">
    <div class="bg-white p-6 rounded-lg shadow-lg flex items-center gap-3">
      <LoadingSpinner size="giant" />
      <Text size="large">{$t('refreshing_albums_for_shared_users')}</Text>
    </div>
  </div>
{/if}

<OnEvents
  {onAlbumUserDelete}
  onAlbumShare={refreshAlbum}
  {onSharedLinkCreate}
  {onSharedLinkDelete}
  onAlbumUpdate={(newAlbum) => (album = newAlbum)}
/>

<Modal title={$t('options')} {onClose} size="small">
  <ModalBody>
    <Stack gap={6}>
      <div>
        <Text size="medium" fontWeight="semi-bold">{$t('settings')}</Text>
        <div class="grid gap-y-3 ps-2 mt-2">
          {#if album.order}
            <Field label={$t('display_order')}>
              <Select
                value={album.order}
                options={[
                  { label: $t('newest_first'), value: AssetOrder.Desc },
                  { label: $t('oldest_first'), value: AssetOrder.Asc },
                ]}
                onChange={(value) => handleUpdateAlbum(album, { order: value })}
              />
            </Field>
          {/if}
          <Field label={$t('comments_and_likes')} description={$t('let_others_respond')}>
            <Switch
              checked={album.isActivityEnabled}
              onCheckedChange={(checked) => handleUpdateAlbum(album, { isActivityEnabled: checked })}
            />
          </Field>
        </div>
      </div>

      <div>
        <HStack fullWidth class="justify-between mb-2">
          <Text size="medium" fontWeight="semi-bold">{$t('people')}</Text>
          <HeaderActionButton action={AddUsers} />
        </HStack>
        <div class="ps-2">
          <div class="flex items-center gap-2 mb-2">
            <div>
              <UserAvatar user={album.owner} size="md" />
            </div>
            <Text class="w-full" size="small">{album.owner.name}</Text>
            <Field disabled class="w-32 shrink-0">
              <Select options={[{ label: $t('owner'), value: 'owner' }]} value="owner" />
            </Field>
          </div>

          {#each album.albumUsers as { user, role } (user.id)}
            <div class="flex items-center justify-between gap-4 py-2">
              <div class="flex flex-row items-center gap-2">
                <div>
                  <UserAvatar {user} size="md" />
                </div>
                <Text size="small">{user.name}</Text>
              </div>
              <Field class="w-32">
                <Select
                  value={role}
                  options={[
                    { label: $t('role_editor'), value: AlbumUserRole.Editor },
                    { label: $t('role_viewer'), value: AlbumUserRole.Viewer },
                    { label: $t('remove_user'), value: 'none' },
                  ] as SelectOption<AlbumUserRole | 'none'>[]}
                  onChange={(value) => handleRoleSelect(user, value)}
                />
              </Field>
            </div>
          {/each}
          {#if album.albumUsers.length > 0}
            <Button
              variant="outline"
              size="small"
              color="primary"
              leadingIcon={mdiSync}
              class="mt-2"
              onclick={() => handleRefreshAlbumsForSharedUsersClick(album)}
            >
              {$t('refresh_albums_for_shared_users')}
            </Button>
          {/if}
        </div>
      </div>
      <div class="mb-4">
        <HStack class="justify-between mb-2">
          <Text size="medium" fontWeight="semi-bold">{$t('shared_links')}</Text>
          <HeaderActionButton action={CreateSharedLink} />
        </HStack>

        <div class="ps-2">
          <Stack gap={4}>
            {#each sharedLinks as sharedLink (sharedLink.id)}
              <AlbumSharedLink {album} {sharedLink} />
            {/each}
          </Stack>
        </div>
      </div>
    </Stack>
  </ModalBody>
</Modal>
