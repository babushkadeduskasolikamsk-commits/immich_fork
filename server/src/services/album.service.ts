import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumInfoDto,
  AlbumResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  AlbumStatisticsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  mapAlbum,
  MapAlbumDto,
  mapAlbumWithAssets,
  mapAlbumWithoutAssets,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
} from 'src/dtos/album.dto';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { AlbumUserRole, Permission } from 'src/enum';
import { AlbumAssetCount, AlbumInfoOptions } from 'src/repositories/album.repository';
import { BaseService } from 'src/services/base.service';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { getPreferences } from 'src/utils/preferences';

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getOwned(auth.user.id),
      this.albumRepository.getShared(auth.user.id),
      this.albumRepository.getNotShared(auth.user.id),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll({ user: { id: ownerId } }: AuthDto, { assetId, shared }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    await this.albumRepository.updateThumbnails();

    let albums: MapAlbumDto[];
    if (assetId) {
      albums = await this.albumRepository.getByAssetId(ownerId, assetId);
    } else if (shared === true) {
      albums = await this.albumRepository.getShared(ownerId);
    } else if (shared === false) {
      albums = await this.albumRepository.getNotShared(ownerId);
    } else {
      albums = await this.albumRepository.getOwned(ownerId);
    }

    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(albums.map((album) => album.id));
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    // fetch mine shared users per album

    const sharedUsersForAlbums = await Promise.all(
      albums.map(
        album => this.fetchSharedUsersForAlbum(
          { user: { id: ownerId } } as AuthDto,
          album.id,
          album.ownerId
        )
      )
    )

    for (let i = 0; i <= sharedUsersForAlbums.length - 1; i++) {
      albums[i].albumUsers = sharedUsersForAlbums?.[i] ?? []
    }

    return albums.map((album) => ({
      ...mapAlbumWithoutAssets(album),
      sharedLinks: undefined,
      startDate: albumMetadata[album.id]?.startDate ?? undefined,
      endDate: albumMetadata[album.id]?.endDate ?? undefined,
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
      lastModifiedAssetTimestamp: albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined,
    }));
  }

  // get album info including shared users!
  async get(auth: AuthDto, id: string, dto: AlbumInfoDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const withAssets = dto.withoutAssets === undefined ? true : !dto.withoutAssets;
    const album = await this.findOrFail(id, { withAssets });
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id]);

    // clear album user since we override it
    album.albumUsers = await this.fetchSharedUsersForAlbum(auth, album.id, album.ownerId);
    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 0;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...mapAlbum(album, withAssets, auth),
      startDate: albumMetadataForIds?.startDate ?? undefined,
      endDate: albumMetadataForIds?.endDate ?? undefined,
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined,
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }


  private async fetchSharedUsersForAlbum(
    auth: AuthDto,
    albumId: string,
    ownerId: string,
  ): Promise<Array<{ user: any; role: AlbumUserRole }>> {
    const apiUrl = process.env.GET_SHARED_USERS_FOR_ALBUM_FULL_API_URL;
    if (!apiUrl) {
      throw new BadRequestException('Shared users API URL not configured');
    }

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          albumOwnerId: ownerId,
          albumId: albumId,
          currentUserId: auth.user.id,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new BadRequestException(
          `Failed to fetch shared users: ${errorData.message || response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        payload: { users: Array<{ userId: string; role: AlbumUserRole }> };
      };
      const users = data.payload.users;

      const existingUsers = (
        await Promise.all(users.map((user) => this.userRepository.get(user.userId, {})))
      ).filter((user) => !!user);

      return existingUsers.map((user) => {
        const userRoleInfo = users.find((sUser) => sUser.userId === user.id);
        return {
          role: userRoleInfo ? userRoleInfo.role : AlbumUserRole.Viewer,
          user: {
            avatarColor: user.avatarColor,
            email: user.email,
            id: user.id,
            name: user.name,
            profileChangedAt: user.profileChangedAt,
            profileImagePath: user.profileImagePath,
          },
        };
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`Failed to fetch shared users: ${(error as Error).message}`);
    }
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = dto.albumUsers || [];

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        throw new BadRequestException('User not found');
      }

      if (userId == auth.user.id) {
        throw new BadRequestException('Cannot share album with owner');
      }
    }

    const allowedAssetIdsSet = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds || [],
    });
    const assetIds = [...allowedAssetIdsSet].map((id) => id);

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        ownerId: auth.user.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
      },
      assetIds,
      albumUsers,
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId });
    }

    return mapAlbumWithAssets(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, { withAssets: true });

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }
    const updatedAlbum = await this.albumRepository.update(album.id, {
      id: album.id,
      albumName: dto.albumName,
      description: dto.description,
      albumThumbnailAssetId: dto.albumThumbnailAssetId,
      isActivityEnabled: dto.isActivityEnabled,
      order: dto.order,
    });

    return mapAlbumWithoutAssets({ ...updatedAlbum, assets: album.assets });
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });


    await this.checkIfAssetCouldBeAddedToAlbums(auth, [id])

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids },
    );

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(id, {
        id,
        updatedAt: new Date(),
        albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
      });

      const allUsersExceptUs = [...album.albumUsers.map(({ user }) => user.id), album.owner.id].filter(
        (userId) => userId !== auth.user.id,
      );

      for (const recipientId of allUsersExceptUs) {
        await this.eventRepository.emit('AlbumUpdate', { id, recipientId });
      }
    }

    return results;
  }


  private async checkIfAssetCouldBeAddedToAlbums(auth: AuthDto, allowedAlbumIds: string[]) {

    // TODO here check if I am an original owner of an album
    const isOwnerApiUrl = process.env.IS_ALBUM_OWNER_FULL_API_URL;
    if (!isOwnerApiUrl) {
      throw new BadRequestException('Is owner API URL not configured');
    }

    const nonOwnedAlbums: string[] = [];
    for (const albumId of allowedAlbumIds) {
      try {
        const response = await fetch(isOwnerApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ albumId, userId: auth.user.id }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || response.statusText);
        }

        const result = await response.json() as { payload: { isOwner: boolean } };
        if (!result.payload?.isOwner) {
          nonOwnedAlbums.push(albumId);
        }
      } catch (error) {
        throw new BadRequestException(
          `Ownership check failed for album ${albumId}: ${(error as Error).message}`
        );
      }
    }

    if (nonOwnedAlbums.length > 0) {
      throw new BadRequestException(
        `User is not the original owner of album(s): ${nonOwnedAlbums.join(', ')}`
      );
    }


  }


  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });

    await this.checkIfAssetCouldBeAddedToAlbums(auth, Array.from(allowedAlbumIds))

    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const events: { id: string; recipients: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds].filter((id) => !existingAssetIds.has(id));
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, { withAssets: false });
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      await this.albumRepository.update(albumId, {
        id: albumId,
        updatedAt: new Date(),
        albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
      });
      const allUsersExceptUs = [...album.albumUsers.map(({ user }) => user.id), album.owner.id].filter(
        (userId) => userId !== auth.user.id,
      );
      events.push({ id: albumId, recipients: allUsersExceptUs });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const event of events) {
      for (const recipientId of event.recipients) {
        await this.eventRepository.emit('AlbumUpdate', { id: event.id, recipientId });
      }
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, { withAssets: false });
    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0 && album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
      await this.albumRepository.updateThumbnails();
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, { withAssets: false });

    for (const { userId, role } of albumUsers) {
      if (album.ownerId === userId) {
        throw new BadRequestException('Cannot be shared with owner');
      }

      const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
      if (exists) {
        throw new BadRequestException('User already added');
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        throw new BadRequestException('User not found');
      }

      // Call external API to share album
      const apiUrl = process.env.SHARE_ALBUM_FULL_API_URL;
      if (!apiUrl) {
        throw new BadRequestException('Share album API URL not configured');
      }

      let serviceJsonResponse = null;
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            currentUserId: album.ownerId,
            albumId: id,
            shareWithUserId: userId,
            userRole: role
          })
        });

        serviceJsonResponse = await response.json() as { serviceStatus: { message: string } }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new BadRequestException(
            `Failed to share album: ${errorData.message || response.statusText}`
          );
        }
      } catch (error) {
        if (serviceJsonResponse) {
          throw new BadRequestException(`${serviceJsonResponse?.serviceStatus?.message}`);
        }

        if (error instanceof BadRequestException) {
          throw error;
        }

        throw new BadRequestException(`Failed to share album: ${(error as Error).message}`);
      }

      // The original repository calls have been removed to prioritize the external API call
      // If you need to maintain both, you can uncomment these lines:
      // await this.albumUserRepository.create({ userId, albumId: id, role });
      // await this.eventRepository.emit('AlbumInvite', { id, userId });
    }

    return this.findOrFail(id, { withAssets: true }).then(mapAlbumWithoutAssets);
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, { withAssets: false });

    if (album.ownerId === userId) {
      throw new BadRequestException('Cannot remove album owner');
    }

    // const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    // if (!exists) {
    //   throw new BadRequestException('Album not shared with user');
    // }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    // Call external API to share album
    const apiUrl = process.env.DELETE_USER_FROM_SHARED_ALBUM_FULL_API_URL;
    if (!apiUrl) {
      throw new BadRequestException('Share delete user from album API URL not configured');
    }

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          currentUserId: album.ownerId,
          albumId: id,
          deleteFromAlbumUserId: userId
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new BadRequestException(
          `Failed to share album: ${errorData.message || response.statusText}`
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`Failed to share album: ${(error as Error).message}`);
    }


    //await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  private async findOrFail(id: string, options: AlbumInfoOptions) {
    const album = await this.albumRepository.getById(id, options);
    if (!album) {
      throw new BadRequestException('Album not found');
    }
    return album;
  }
}
