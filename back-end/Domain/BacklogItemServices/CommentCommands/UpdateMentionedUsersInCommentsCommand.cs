﻿using System.Text.RegularExpressions;

using Raven.Client;
using Raven.Client.Documents.Queries;
using Raven.Client.Documents.Session;
using Raven.Yabt.Database.Common.References;
using Raven.Yabt.Database.Models.BacklogItems;
using Raven.Yabt.Database.Models.BacklogItems.Indexes;
using Raven.Yabt.Database.Models.Users;
using Raven.Yabt.Domain.Helpers;
using Raven.Yabt.Domain.Infrastructure;
using Raven.Yabt.Domain.UserServices.Command;

namespace Raven.Yabt.Domain.BacklogItemServices.CommentCommands
{
	internal class UpdateMentionedUsersInCommentsCommand : IUpdateUserReferencesCommand
	{
		private readonly IPatchOperationsAddDeferred _patchOperations;
		private readonly IAsyncDocumentSession _dbSession;

		public UpdateMentionedUsersInCommentsCommand(IAsyncDocumentSession dbSession, IPatchOperationsAddDeferred patchOperations)
		{
			_dbSession = dbSession;
			_patchOperations = patchOperations;
		}

		public void ClearUserId(string userId)
		{
			// Replace invalid characters with empty strings. Can't pass it as a parameter, as string parameters get wrapped in '\"' when inserted
			var sanitisedUserId = Regex.Replace(userId, @"[^\w\.@-]", "");
			// Get full ID
			var idForDynamicField = _dbSession.GetIdForDynamicField<User>(sanitisedUserId);
			var fullId = _dbSession.GetFullId<User>(userId);

			// Form a patch query
			var queryString = $@"FROM INDEX '{new BacklogItems_ForList().IndexName}' AS i
								WHERE i.{nameof(BacklogItemIndexedForList.MentionedUser)}_{idForDynamicField} != null
								UPDATE
								{{
									i.{nameof(BacklogItem.Comments)}.forEach(comment => 
										{{
											let mentionedUsers = comment.{nameof(Comment.MentionedUserIds)};
											if (mentionedUsers != null)
												Object.keys(mentionedUsers).forEach(key =>
												{{
													if (mentionedUsers[key].toLowerCase() == '{fullId}'.toLowerCase())
														delete mentionedUsers[key];
												}});
											return comment;
										}});
								}}";
			var query = new IndexQuery { Query = queryString };

			// Add the patch to a collection
			_patchOperations.AddDeferredPatchQuery(query);
		}

		public void UpdateReferences(UserReference newUserReference)
		{
			if (string.IsNullOrEmpty(newUserReference.Id))
				return;

			// Replace invalid characters with empty strings. Can't pass it as a parameter, as string parameters get wrapped in '\"' when inserted
			var idForDynamicField = GetSanitizedUserId(newUserReference.Id);

			// Form a patch query
			var queryString = $@"FROM INDEX '{new BacklogItems_ForList().IndexName}' AS i
								WHERE i.{nameof(BacklogItemIndexedForList.MentionedUser)}_{idForDynamicField} != null
								UPDATE
								{{
									i.{nameof(BacklogItem.Comments)}.forEach(comment => 
										{{
											let mentionedUsers = comment.{nameof(Comment.MentionedUserIds)};
											if (mentionedUsers != null)
												Object.keys(mentionedUsers).forEach(key =>
												{{
													if (mentionedUsers[key].toLowerCase() == $userId.toLowerCase())
													{{
														// Replace the element in the dictionary with the new reference  
														delete mentionedUsers[key];
														mentionedUsers[$newMention] = $userId;
														// Replace references in the comment's text
														let regEx = new RegExp('@'+key,'gi');
														comment.{nameof(Comment.Message)} = comment.{nameof(Comment.Message)}.replace(regEx, '@'+$newMention);
													}}
												}});
											return comment;
										}});
								}}";
			var query = new IndexQuery
			{
				Query = queryString,
				QueryParameters = new Parameters
				{
					{ "userId", newUserReference.Id },
					{ "newMention", newUserReference!.MentionedName },
				}
			};

			// Add the patch to a collection
			_patchOperations.AddDeferredPatchQuery(query);
		}
		
		private static string GetSanitizedUserId(string userId) =>  Regex.Replace(userId, @"[^\w\.@-]", "");
	}
}
