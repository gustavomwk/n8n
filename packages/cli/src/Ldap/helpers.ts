/* eslint-disable @typescript-eslint/no-use-before-define */
import type { Entry as LdapUser } from 'ldapts';
import { Filter } from 'ldapts/filters/Filter';
import { Container } from 'typedi';
import { validate } from 'jsonschema';

import * as Db from '@/Db';
import config from '@/config';
import { User } from '@db/entities/User';
import { AuthIdentity } from '@db/entities/AuthIdentity';
import type { AuthProviderSyncHistory } from '@db/entities/AuthProviderSyncHistory';

import {
	BINARY_AD_ATTRIBUTES,
	LDAP_CONFIG_SCHEMA,
	LDAP_LOGIN_ENABLED,
	LDAP_LOGIN_LABEL,
} from './constants';
import type { ConnectionSecurity, LdapConfig } from './types';
import { License } from '@/License';
import { AuthUserRepository } from '@db/repositories/authUser.repository';
import { AuthProviderSyncHistoryRepository } from '@db/repositories/authProviderSyncHistory.repository';
import { AuthIdentityRepository } from '@db/repositories/authIdentity.repository';
import type { AuthUser } from '@db/entities/AuthUser';

/**
 *  Check whether the LDAP feature is disabled in the instance
 */
export const isLdapEnabled = () => {
	return Container.get(License).isLdapEnabled();
};

/**
 * Retrieve the LDAP login label from the configuration object
 */
export const getLdapLoginLabel = (): string => config.getEnv(LDAP_LOGIN_LABEL);

/**
 * Retrieve the LDAP login enabled from the configuration object
 */
export const isLdapLoginEnabled = (): boolean => config.getEnv(LDAP_LOGIN_ENABLED);

/**
 * Return a random password to be assigned to the LDAP users
 */
export const randomPassword = (): string => {
	return Math.random().toString(36).slice(-8);
};

/**
 * Validate the structure of the LDAP configuration schema
 */
export const validateLdapConfigurationSchema = (
	ldapConfig: LdapConfig,
): { valid: boolean; message: string } => {
	const { valid, errors } = validate(ldapConfig, LDAP_CONFIG_SCHEMA, { nestedErrors: true });

	let message = '';
	if (!valid) {
		message = errors.map((error) => `request.body.${error.path[0]} ${error.message}`).join(',');
	}
	return { valid, message };
};

export const resolveEntryBinaryAttributes = (entry: LdapUser): LdapUser => {
	Object.entries(entry)
		.filter(([k]) => BINARY_AD_ATTRIBUTES.includes(k))
		.forEach(([k]) => {
			entry[k] = (entry[k] as Buffer).toString('hex');
		});
	return entry;
};

export const resolveBinaryAttributes = (entries: LdapUser[]): void => {
	entries.forEach((entry) => resolveEntryBinaryAttributes(entry));
};

export const createFilter = (filter: string, userFilter: string) => {
	let _filter = `(&(|(objectClass=person)(objectClass=user))${filter})`;
	if (userFilter) {
		_filter = `(&${userFilter}${filter}`;
	}
	return _filter;
};

export const escapeFilter = (filter: string): string => {
	//@ts-ignore
	return new Filter().escape(filter); /* eslint-disable-line */
};

/**
 * Retrieve auth identity by LDAP ID from database
 */
export const getAuthIdentityByLdapId = async (
	idAttributeValue: string,
): Promise<AuthIdentity | null> => {
	return await Container.get(AuthIdentityRepository).findOne({
		relations: { user: true },
		where: {
			providerId: idAttributeValue,
			providerType: 'ldap',
		},
	});
};

/**
 * Map attributes from the LDAP server to the proper columns in the database
 * e.g. mail => email | uid => ldapId
 */
export const mapLdapAttributesToUser = (
	ldapUser: LdapUser,
	ldapConfig: LdapConfig,
): [AuthIdentity['providerId'], Pick<User, 'email' | 'firstName' | 'lastName'>] => {
	return [
		ldapUser[ldapConfig.ldapIdAttribute] as string,
		{
			email: ldapUser[ldapConfig.emailAttribute] as string,
			firstName: ldapUser[ldapConfig.firstNameAttribute] as string,
			lastName: ldapUser[ldapConfig.lastNameAttribute] as string,
		},
	];
};

/**
 * Retrieve LDAP ID of all LDAP users in the database
 */
export const getLdapIds = async (): Promise<string[]> => {
	const identities = await Container.get(AuthIdentityRepository).find({
		select: ['providerId'],
		where: {
			providerType: 'ldap',
		},
	});
	return identities.map((i) => i.providerId);
};

export const getLdapUsers = async (): Promise<User[]> => {
	const identities = await Container.get(AuthIdentityRepository).find({
		relations: { user: true },
		where: {
			providerType: 'ldap',
		},
	});
	return identities.map((i) => i.user);
};

/**
 * Map a LDAP user to database user
 */
export const mapLdapUserToDbUser = (
	ldapUser: LdapUser,
	ldapConfig: LdapConfig,
	toCreate = false,
): [string, User] => {
	const user = new User();
	const [ldapId, data] = mapLdapAttributesToUser(ldapUser, ldapConfig);
	Object.assign(user, data);
	if (toCreate) {
		user.role = 'global:member';
		user.password = randomPassword();
		user.disabled = false;
	} else {
		user.disabled = true;
	}
	return [ldapId, user];
};

/**
 * Save "toCreateUsers" in the database
 * Update "toUpdateUsers" in the database
 * Update "ToDisableUsers" in the database
 */
export const processUsers = async (
	toCreateUsers: Array<[string, User]>,
	toUpdateUsers: Array<[string, User]>,
	toDisableUsers: string[],
): Promise<void> => {
	const authUserRepository = Container.get(AuthUserRepository);
	await Db.transaction(async (transactionManager) => {
		return await Promise.all([
			...toCreateUsers.map(async ([ldapId, user]) => {
				const { user: savedUser } = await authUserRepository.createUserWithProject(
					user,
					transactionManager,
				);
				const authIdentity = AuthIdentity.create(savedUser, ldapId);
				return await transactionManager.save(authIdentity);
			}),
			...toUpdateUsers.map(async ([ldapId, user]) => {
				const authIdentity = await transactionManager.findOneBy(AuthIdentity, {
					providerId: ldapId,
				});
				if (authIdentity?.userId) {
					await transactionManager.update(
						User,
						{ id: authIdentity.userId },
						{ email: user.email, firstName: user.firstName, lastName: user.lastName },
					);
				}
			}),
			...toDisableUsers.map(async (ldapId) => {
				const authIdentity = await transactionManager.findOneBy(AuthIdentity, {
					providerId: ldapId,
				});
				if (authIdentity?.userId) {
					const user = await transactionManager.findOneBy(User, { id: authIdentity.userId });

					if (user) {
						user.disabled = true;
						await transactionManager.save(user);
					}

					await transactionManager.delete(AuthIdentity, { userId: authIdentity?.userId });
				}
			}),
		]);
	});
};

/**
 * Save a LDAP synchronization data to the database
 */
export const saveLdapSynchronization = async (
	data: Omit<AuthProviderSyncHistory, 'id' | 'providerType'>,
): Promise<void> => {
	await Container.get(AuthProviderSyncHistoryRepository).save(
		{
			...data,
			providerType: 'ldap',
		},
		{ transaction: false },
	);
};

/**
 * Retrieve all LDAP synchronizations in the database
 */
export const getLdapSynchronizations = async (
	page: number,
	perPage: number,
): Promise<AuthProviderSyncHistory[]> => {
	const _page = Math.abs(page);
	return await Container.get(AuthProviderSyncHistoryRepository).find({
		where: { providerType: 'ldap' },
		order: { id: 'DESC' },
		take: perPage,
		skip: _page * perPage,
	});
};

/**
 * Format the LDAP connection URL to conform with LDAP client library
 */
export const formatUrl = (url: string, port: number, security: ConnectionSecurity) => {
	const protocol = ['tls'].includes(security) ? 'ldaps' : 'ldap';
	return `${protocol}://${url}:${port}`;
};

export const getMappingAttributes = (ldapConfig: LdapConfig): string[] => {
	return [
		ldapConfig.emailAttribute,
		ldapConfig.ldapIdAttribute,
		ldapConfig.firstNameAttribute,
		ldapConfig.lastNameAttribute,
		ldapConfig.emailAttribute,
	];
};

export const createLdapAuthIdentity = async (user: AuthUser, ldapId: string) => {
	return await Container.get(AuthIdentityRepository).save(AuthIdentity.create(user, ldapId), {
		transaction: false,
	});
};

export const createLdapUserOnLocalDb = async (data: Partial<User>, ldapId: string) => {
	const { user } = await Container.get(AuthUserRepository).createUserWithProject({
		password: randomPassword(),
		role: 'global:member',
		...data,
	});
	await createLdapAuthIdentity(user, ldapId);
	return user;
};

export const updateLdapUserOnLocalDb = async (identity: AuthIdentity, data: Partial<User>) => {
	const userId = identity?.user?.id;
	if (userId) {
		const user = await Container.get(AuthUserRepository).findOneBy({ id: userId });

		if (user) {
			await Container.get(AuthUserRepository).save({ id: userId, ...data }, { transaction: true });
		}
	}
};

export const deleteAllLdapIdentities = async () => {
	return await Container.get(AuthIdentityRepository).delete({ providerType: 'ldap' });
};
