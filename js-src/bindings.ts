/**
 * Copyright 2023 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import type { C2paOptions, Signer } from './';
import {
  CreateIngredientError,
  InvalidStorageOptionsError,
  MissingSignerError,
  SigningError,
} from './lib/error';
import { getResourceReference, labeledSha } from './lib/hash';
import { ManifestBuilder } from './lib/manifestBuilder';
import { createThumbnail } from './lib/thumbnail';
import type {
  Ingredient,
  Manifest,
  ResourceStore as ManifestResourceStore,
  ManifestStore,
  SignatureInfo,
} from './types';

const bindings = require(process.env.C2PA_LIBRARY_PATH ??
  '../generated/c2pa.node');

const missingErrors = [
  // No embedded or remote provenance found in the asset
  'C2pa(ProvenanceMissing)',
  // JUMBF not found
  'C2pa(JumbfNotFound)',
];

export type ResourceStore = Record<string, ManifestResourceStore>;

export interface ResolvedResource {
  format: string;
  data: Buffer | null;
}

export interface ResolvedSignatureInfo extends SignatureInfo {
  timeObject?: Date | null;
}

export interface ResolvedManifest
  extends Omit<Manifest, 'ingredients' | 'thumbnail'> {
  ingredients: ResolvedIngredient[];
  thumbnail: ResolvedResource | null;
  signature_info?: ResolvedSignatureInfo | null;
}

export interface ResolvedManifestStore
  extends Omit<ManifestStore, 'active_manifest'> {
  active_manifest: ResolvedManifest | null;
  manifests: Record<string, ResolvedManifest>;
}

function parseSignatureInfo(manifest: Manifest) {
  const info = manifest.signature_info;
  if (!info) {
    return {};
  }

  return {
    signature_info: {
      ...info,
      timeObject:
        typeof info.time === 'string' ? new Date(info.time) : info.time,
    },
  };
}

export interface ResolvedIngredient extends Omit<Ingredient, 'thumbnail'> {
  manifest: Manifest | null;
  thumbnail: ResolvedResource | null;
}

function createIngredientResolver(
  manifestStore: ManifestStore,
  resourceStore: ManifestResourceStore,
) {
  return (ingredient: Ingredient): ResolvedIngredient => {
    const relatedManifest = ingredient.active_manifest;
    const thumbnailIdentifier = ingredient.thumbnail?.identifier;
    const thumbnailResource = thumbnailIdentifier
      ? resourceStore[thumbnailIdentifier]
      : null;

    return {
      ...ingredient,
      manifest: relatedManifest
        ? manifestStore.manifests[relatedManifest]
        : null,
      thumbnail: thumbnailResource
        ? {
            format: ingredient.thumbnail?.format ?? '',
            data: Buffer.from(thumbnailResource.buffer),
          }
        : null,
    };
  };
}

export function resolveManifest(
  manifestStore: ManifestStore,
  manifest: Manifest,
  resourceStore: ManifestResourceStore,
): ResolvedManifest {
  const thumbnailIdentifier = manifest.thumbnail?.identifier;
  const thumbnailResource = thumbnailIdentifier
    ? resourceStore[thumbnailIdentifier]
    : null;
  const ingredientResolver = createIngredientResolver(
    manifestStore,
    resourceStore,
  );

  return {
    ...manifest,
    ...parseSignatureInfo(manifest),
    ingredients: (manifest.ingredients ?? []).map(ingredientResolver),
    thumbnail: thumbnailResource
      ? {
          format: manifest.thumbnail?.format ?? '',
          data: Buffer.from(thumbnailResource.buffer),
        }
      : null,
  } as ResolvedManifest;
}

export interface Asset {
  mimeType: string;
  buffer: Buffer;
}

/**
 * Reads C2PA data from an asset
 * @param mimeType The MIME type of the asset, for instance `image/jpeg`
 * @param buffer A buffer containing the asset data
 * @returns A promise containing C2PA data, if present
 */
export async function read(
  asset: Asset | string,
): Promise<ResolvedManifestStore | null> {
  try {
    let result;
    if (typeof asset === 'string') {
      result = await bindings.read_file(asset);
    } else {
      const { mimeType, buffer } = asset;
      result = await bindings.read_buffer(mimeType, buffer);
    }
    const manifestStore = JSON.parse(result.manifest_store) as ManifestStore;
    const resourceStore = result.resource_store as ResourceStore;
    const activeManifestLabel = manifestStore.active_manifest;
    const manifests: ResolvedManifestStore['manifests'] = Object.keys(
      manifestStore.manifests,
    ).reduce((acc, label) => {
      const manifest = manifestStore.manifests[label] as Manifest;

      return {
        ...acc,
        [label]: resolveManifest(manifestStore, manifest, resourceStore[label]),
      };
    }, {});

    return {
      active_manifest: activeManifestLabel
        ? manifests[activeManifestLabel]
        : null,
      manifests,
      validation_status: manifestStore.validation_status ?? [],
    };
  } catch (err: unknown) {
    if (missingErrors.some((test) => test === (err as Error)?.name)) {
      return null;
    }
    throw err;
  }
}

export interface SignOptions {
  format?: string;
  embed?: boolean;
  remoteManifestUrl?: string | null;
}

type BaseSignProps = {
  // The manifest to sign and optionally embed
  manifest: ManifestBuilder;
  // Allows you to pass in a thumbnail to be used instead of generating one, or `false` to prevent thumbnail generation
  thumbnail?: Asset | false;
  // Allows you to pass in a custom signer for this operation instead of using the global signer (if passed)
  signer?: Signer;
  // Options for this operation
  options?: SignOptions;
};

type BufferSignProps = BaseSignProps & {
  sourceType: 'memory';
  // The asset to sign
  asset: Asset;
};

type FileSignProps = BaseSignProps & {
  sourceType: 'file';
  inputPath: string;
  outputPath: string;
};

export type SignProps = BufferSignProps | FileSignProps;

export interface SignOutput {
  signedAsset: Asset | string;
  signedManifest?: Buffer;
}

export const defaultSignOptions: SignOptions = {
  format: 'application/octet-stream',
  embed: true,
};

export function createSign(globalOptions: C2paOptions) {
  return async function sign(props: SignProps): Promise<SignOutput> {
    const {
      sourceType,
      manifest,
      thumbnail,
      signer: customSigner,
      options,
    } = props;

    const signOptions = Object.assign({}, defaultSignOptions, options);
    const signer = customSigner ?? globalOptions.signer;
    const memoryFileTypes = ['image/jpeg', 'image/png'];

    if (!signer) {
      throw new MissingSignerError();
    }
    if (!signOptions.embed && !signOptions.remoteManifestUrl) {
      throw new InvalidStorageOptionsError();
    }
    if (
      sourceType === 'memory' &&
      !memoryFileTypes.includes(props.asset.mimeType)
    ) {
      throw new Error(
        `Only ${memoryFileTypes.join(
          ', ',
        )} files can be signed using the 'memory' source type.`,
      );
    }

    try {
      const signOpts = { ...signOptions, signer };
      if (!manifest.definition.thumbnail) {
        const thumbnailInput =
          sourceType === 'memory' ? props.asset.buffer : props.inputPath;
        const thumbnailAsset =
          // Use thumbnail if provided
          thumbnail ||
          // Otherwise generate one if configured to do so
          (globalOptions.thumbnail && thumbnail !== false
            ? await createThumbnail(thumbnailInput, globalOptions.thumbnail)
            : null);
        if (thumbnailAsset) {
          await manifest.addThumbnail(thumbnailAsset);
        }
      }

      if (sourceType === 'memory') {
        const { mimeType, buffer } = props.asset;
        const assetSignOpts = { ...signOpts, format: mimeType };
        const result = await bindings.sign_buffer(
          manifest.asSendable(),
          buffer,
          assetSignOpts,
        );
        const { assetBuffer: signedAssetBuffer, manifest: signedManifest } =
          result;
        const signedAsset: Asset = {
          mimeType,
          buffer: Buffer.from(signedAssetBuffer),
        };
        return {
          signedAsset,
          signedManifest: signedManifest
            ? Buffer.from(signedManifest)
            : undefined,
        };
      } else {
        const { inputPath, outputPath } = props;
        const result = await bindings.sign_file(
          manifest.asSendable(),
          inputPath,
          outputPath,
          signOpts,
        );
        return {
          signedAsset: result.outputPath,
        };
      }
    } catch (err: unknown) {
      throw new SigningError({ cause: err });
    }
  };
}

export interface SignClaimBytesProps {
  claim: Buffer;
  reserveSize: number;
  signer: Signer;
}

export async function signClaimBytes({
  claim,
  reserveSize,
  signer,
}: SignClaimBytesProps): Promise<Buffer> {
  try {
    const result = await bindings.sign_claim_bytes(claim, reserveSize, signer);

    return Buffer.from(result);
  } catch (err: unknown) {
    throw new SigningError({ cause: err });
  }
}

export type IngredientResourceStore = Record<string, Buffer>;

export interface StorableIngredient {
  ingredient: Ingredient;
  resources: IngredientResourceStore;
}

export interface CreateIngredientProps {
  // The ingredient data to create an ingredient from. This can be an `Asset` if you want to process data in memory, or
  // a string if you want to pass in a path to a file to be processed.
  asset: Asset | string;
  // Title of the ingredient
  title: string;
  // Pass an `Asset` if you would like to supply a thumbnail, or `false` to disable thumbnail generation
  // If no value is provided, a thumbnail will be generated if configured to do so globally
  thumbnail?: Asset | false;
}

export function createIngredientFunction(options: C2paOptions) {
  /**
   * @notExported
   * Creates a storable ingredient from an asset.
   *
   * This allows ingredient data to be extracted, optionally stored, and passed in during signing at a later time if needed.
   */
  return async function createIngredient({
    asset,
    title,
    thumbnail,
  }: CreateIngredientProps): Promise<StorableIngredient> {
    try {
      let serializedIngredient: string;
      let existingResources: Record<string, Uint8Array>;

      const hash = await labeledSha(asset, options.ingredientHashAlgorithm);
      if (typeof asset === 'string') {
        ({ ingredient: serializedIngredient, resources: existingResources } =
          await bindings.create_ingredient_from_file(asset));
      } else {
        ({ ingredient: serializedIngredient, resources: existingResources } =
          await bindings.create_ingredient_from_buffer(
            asset.mimeType,
            asset.buffer,
          ));
      }

      const ingredient = JSON.parse(serializedIngredient) as Ingredient;

      // Separate resources out into their own object so they can be stored more easily
      const resources: IngredientResourceStore = Object.keys(
        existingResources,
      ).reduce((acc, identifier) => {
        return {
          ...acc,
          [identifier]: Buffer.from(existingResources[identifier]),
        };
      }, {});

      // Clear out resources since we are not using this field
      ingredient.resources = undefined;
      ingredient.title = title;
      ingredient.hash = hash;

      // Generate a thumbnail if one doesn't exist on the ingredient's manifest
      if (!ingredient.thumbnail) {
        const thumbnailInput = typeof asset === 'string' ? asset : asset.buffer;
        const thumbnailAsset =
          // Use thumbnail if provided
          thumbnail ||
          // Otherwise generate one if configured to do so
          (options.thumbnail && thumbnail !== false
            ? await createThumbnail(thumbnailInput ?? asset, options.thumbnail)
            : null);
        if (thumbnailAsset) {
          const resourceRef = await getResourceReference(
            thumbnailAsset,
            ingredient.instance_id,
          );
          ingredient.thumbnail = resourceRef;
          resources[resourceRef.identifier] = thumbnailAsset.buffer;
        }
      }

      return {
        ingredient,
        resources,
      };
    } catch (err: unknown) {
      throw new CreateIngredientError({ cause: err });
    }
  };
}
